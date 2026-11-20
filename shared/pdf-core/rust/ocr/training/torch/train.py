import argparse
from functools import partial
import hashlib
import json
import math
from pathlib import Path
import struct
import subprocess
import time

import torch
from torch import nn
from torch.optim.swa_utils import AveragedModel, get_ema_multi_avg_fn
from torch.utils.data import DataLoader

from data import Archive, batches, collate, dataset, manifest
from model import LABELS, Recognizer, normalize, transcript
from model_v5 import Recognizer as RecognizerV5, normalize as normalize_v5
from scan import Scan


def edits(reference, prediction):
    row = list(range(len(prediction) + 1))
    for index, expected in enumerate(reference, 1):
        next_row = [index]
        for column, actual in enumerate(prediction, 1):
            next_row.append(min(row[column] + 1, next_row[-1] + 1,
                                row[column - 1] + (expected != actual)))
        row = next_row
    return row[-1]


def raw_metrics(pairs):
    return {
        "lines": len(pairs),
        "character_edits": sum(edits(ref, guess) for ref, guess in pairs),
        "characters": sum(len(ref) for ref, _ in pairs),
        "word_edits": sum(edits(ref.split(), guess.split()) for ref, guess in pairs),
        "words": sum(len(ref.split()) for ref, _ in pairs),
    }


@torch.inference_mode()
def evaluate(model, lines, batch_size, mode):
    pairs = []
    for batch in DataLoader(lines, batch_sampler=batches(lines, batch_size, 0, 0),
                            collate_fn=collate):
        inputs, lengths, _, _, references, _ = batch
        outputs = model(inputs, lengths, mode).argmax(dim=1)
        pairs.extend((reference, transcript(output[:length]))
                     for output, length, reference in zip(outputs, lengths, references, strict=True))
    result = raw_metrics(pairs)
    normalized = raw_metrics([(ref.casefold(), guess.casefold()) for ref, guess in pairs])
    result.update(cer=result["character_edits"] / max(1, result["characters"]),
                  wer=result["word_edits"] / max(1, result["words"]),
                  normalized_cer=normalized["character_edits"] / max(1, normalized["characters"]),
                  normalized_wer=normalized["word_edits"] / max(1, normalized["words"]))
    return result


def log(directory, **fields):
    line = json.dumps(fields, ensure_ascii=False, allow_nan=False)
    print(line, flush=True)
    with (directory / "curves.jsonl").open("a") as output:
        output.write(line + "\n")


def atomic(path, write):
    pending = path.with_suffix(path.suffix + ".tmp")
    write(pending)
    pending.replace(path)


def warm_start(model, ema, warm, args):
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.003, weight_decay=0.01, fused=True)
    weights = torch.full((len(LABELS),), 1.0)
    weights[0] = 0.25
    classify = nn.CrossEntropyLoss(weight=weights)
    for epoch in range(args.warm_epochs):
        total = 0.0
        updates = 0
        for batch in DataLoader(warm, batch_sampler=batches(warm, args.batch_size, args.seed + epoch, 0),
                                collate_fn=collate):
            if batch is None:
                continue
            inputs, lengths, _, _, _, alignments = batch
            optimizer.zero_grad(set_to_none=True)
            loss = classify(model(inputs, lengths), alignments)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            optimizer.step()
            ema.update_parameters(model)
            total += loss.item()
            updates += 1
        if not updates:
            raise ValueError("no aligned bootstrap lines")
        log(args.output, event="warm", epoch=epoch + 1, frame_loss=total / updates)


def train(args):
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    torch.manual_seed(args.seed)
    args.output.mkdir(parents=True, exist_ok=True)
    checkpoint = args.output / "checkpoint.pt"
    if checkpoint.exists() != args.resume:
        raise ValueError("use --resume for an existing checkpoint or choose a fresh output directory")
    paths = [Path(line) for line in args.shards.read_text().splitlines() if line]
    supplement = ([Path(line) for line in args.supplement.read_text().splitlines() if line]
                  if args.supplement else [])
    if len(set(paths + supplement)) != len(paths) + len(supplement) or not paths:
        raise ValueError("training rosters must contain distinct OCRL archive paths")
    if not 0 <= args.supplement_fraction < 1 or bool(supplement) != bool(args.supplement_fraction):
        raise ValueError("use --supplement and a nonzero --supplement-fraction together")
    if not 0 <= args.qat < args.epochs or args.epochs < 2:
        raise ValueError("reserve at least one epoch for fp32 training")
    if args.batch_size <= 0 or args.steps < 0 or args.workers < 0 or args.learning_rate <= 0:
        raise ValueError("invalid batch size, epoch length, workers, or learning rate")
    if args.initial_run and args.clean:
        raise ValueError("aligned warm start is only for a new recognizer")
    options = {key: value for key, value in vars(args).items()
               if isinstance(value, (int, float)) and key not in ("resume", "threads")}
    if args.architecture and not args.scan_binary:
        raise ValueError("OCR5 training requires the native --scan-binary")
    scan = Scan(args.scan_binary) if args.scan_binary else None
    clean = [args.clean] if args.clean else []
    if args.real_dev.is_dir() and args.real_dev.name != "dev":
        raise ValueError("model selection requires the real development split")
    sources = [("clean", clean), ("shard", paths), ("supplement", supplement)]
    if scan is not None:
        sources.extend([("profile", [scan.profile_path]), ("degradation", [args.scan_binary])])
    training_data = manifest(sources)
    model = RecognizerV5(args.architecture) if args.architecture else Recognizer()
    normalize_line = normalize_v5 if args.architecture else normalize
    parent = None
    if args.initial_run:
        table = (args.initial_run / "best.bin").read_bytes()
        model.load_state_dict(torch.load(args.initial_run / "best.pt", map_location="cpu",
                                         weights_only=True))
        magic, version, _, source, commit, seed, _ = struct.unpack_from("<4sHH32s20sQH", table)
        export = partial(model.table, version=version) if magic == b"OCR5" else model.table
        if export(source.hex(), commit.hex(), seed) != table:
            raise ValueError("parent checkpoint and exported table differ")
        parent = hashlib.sha256(table).hexdigest()
        digest = hashlib.sha256(bytes.fromhex(training_data) + bytes.fromhex(parent)).hexdigest()
    else:
        digest = training_data
    log(args.output, event="indexing", shards=len(paths), manifest=digest, parent=parent,
        architecture=args.architecture, parameters=sum(p.numel() for p in model.parameters()))
    lines = Archive(paths, training=True, normalize_line=normalize_line, scan=scan,
                    supplement=supplement)
    warm = Archive(clean, training=True, align=True, normalize_line=normalize_line) if clean else None
    real = dataset(args.real_dev, normalize_line)
    synthetic = dataset(args.synthetic_val, normalize_line)
    if len(real) != 186 or not len(synthetic) or not lines.primary_count or (warm is not None and not len(warm)):
        raise ValueError("training requires 186 real dev lines and nonempty synthetic datasets")
    if supplement and len(lines) == lines.primary_count:
        raise ValueError("no eligible supplemental lines")
    provenance = {
        "training": digest,
        "validation": manifest([
            ("real", [args.real_dev] if args.real_dev.is_file() else
             sorted([*args.real_dev.glob("*.json"), *args.real_dev.glob("*.pgm")])),
            ("synthetic", [args.synthetic_val] if args.synthetic_val.is_file() else
             sorted([*args.synthetic_val.glob("*.json"), *args.synthetic_val.glob("*.pgm")])),
        ]),
        "options": options,
    }
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=0.01,
                                  fused=True)
    ema = AveragedModel(model, multi_avg_fn=get_ema_multi_avg_fn(0.99))
    first_epoch = 0
    best = math.inf
    stale = 0
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if args.resume:
        state = torch.load(checkpoint, map_location="cpu", weights_only=True)
        previous = state["provenance"]
        previous["options"].setdefault("learning_rate", 0.003)
        previous["options"].setdefault("architecture", 0)
        previous["options"].setdefault("supplement_fraction", 0.0)
        if previous != provenance:
            raise ValueError("checkpoint data or training schedule changed")
        model.load_state_dict(state["model"])
        optimizer.load_state_dict(state["optimizer"])
        ema.load_state_dict(state["ema"])
        first_epoch = state["epoch"]
        best = state["best"]
        stale = state["stale"]
        commit = state["commit"]
    ctc = nn.CTCLoss(blank=0, zero_infinity=False)
    log(args.output, event="ready", records=lines.primary_count, rejected=lines.rejected,
        supplement=len(lines) - lines.primary_count,
        clean=len(warm) if warm is not None else 0, start_epoch=first_epoch,
        dev=len(real), synthetic_val=len(synthetic), seed=args.seed, commit=commit)
    if first_epoch == 0 and warm is not None:
        warm_start(model, ema, warm, args)
    primary_batch = args.batch_size - min(args.batch_size - 1, round(args.batch_size * args.supplement_fraction))
    available_steps = math.ceil(lines.primary_count / primary_batch)
    steps = min(args.steps or available_steps, available_steps)
    for epoch in range(first_epoch, args.epochs):
        start = time.perf_counter()
        mode = "qat" if epoch >= args.epochs - args.qat else "float"
        if scan is None:
            curriculum = min(1, (epoch + 1) / 3)
        else:
            curriculum = 1 if args.initial_run else min(1, epoch / 3)
        line_batches = batches(lines, args.batch_size, args.seed, curriculum, args.steps, epoch,
                               args.supplement_fraction)
        loader = DataLoader(lines, batch_sampler=line_batches, collate_fn=collate,
                            num_workers=args.workers)
        loss_total = 0.0
        visited = 0
        updates = 0
        for step, batch in enumerate(loader):
            if batch is None:
                continue
            inputs, lengths, targets, target_lengths, texts, _ = batch
            progress = min(1.0, (epoch + step / steps) / args.epochs)
            rate = args.learning_rate * min(1.0, 0.2 + 20 * progress) * (0.1 + 0.9 *
                                                          (1 + math.cos(math.pi * progress)) / 2)
            optimizer.param_groups[0]["lr"] = rate
            optimizer.zero_grad(set_to_none=True)
            logits = model(inputs, lengths, mode)
            loss = ctc(logits.log_softmax(dim=1).permute(2, 0, 1).contiguous(), targets,
                       lengths, target_lengths)
            if not loss.isfinite():
                raise ValueError(f"non-finite CTC at epoch {epoch + 1}, step {step + 1}")
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            optimizer.step()
            ema.update_parameters(model)
            loss_total += loss.item() * len(texts)
            visited += len(texts)
            updates += 1
            if updates % 100 == 0:
                log(args.output, event="progress", epoch=epoch + 1, visits=visited,
                    updates=updates, ctc=loss_total / visited, seconds=time.perf_counter() - start)
        if not visited:
            raise ValueError("no line fit the CTC frame budget")
        exported = ema.module.eval()
        dev = evaluate(exported, real, args.batch_size, "int8")
        val = evaluate(exported, synthetic, args.batch_size, "int8")
        fp32 = evaluate(exported, real, args.batch_size, "float")
        score = (dev["cer"] + val["cer"]) / 2
        selected = score < best
        if selected:
            best = score
            stale = 0
        else:
            stale += 1
        table = exported.table(digest, commit, args.seed)
        atomic(args.output / "latest.bin", lambda file: file.write_bytes(table))
        if selected:
            atomic(args.output / "best.bin", lambda file: file.write_bytes(table))
            atomic(args.output / "best.pt", lambda file: torch.save(exported.state_dict(), file))
        state = dict(model=model.state_dict(), optimizer=optimizer.state_dict(),
                     ema=ema.state_dict(), epoch=epoch + 1, best=best, stale=stale,
                     commit=commit, provenance=provenance)
        atomic(checkpoint, lambda file: torch.save(state, file))
        log(args.output, event="epoch", epoch=epoch + 1, mode=mode, visits=visited,
            updates=updates, ctc=loss_total / visited, seconds=time.perf_counter() - start,
            dev=dev, dev_fp32=fp32, synthetic_val=val, selected=selected)
        if args.patience and stale >= args.patience and (mode == "qat" or not args.qat):
            break


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--shards", type=Path, required=True)
    parser.add_argument("--supplement", type=Path)
    parser.add_argument("--supplement-fraction", type=float, default=0.0)
    parser.add_argument("--clean", type=Path)
    parser.add_argument("--initial-run", type=Path)
    parser.add_argument("--synthetic-val", type=Path, required=True)
    parser.add_argument("--real-dev", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--architecture", type=int, choices=(0, 1, 2, 3), default=0)
    parser.add_argument("--seed", type=int, default=7291)
    parser.add_argument("--learning-rate", type=float, default=0.003)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--qat", type=int, default=2)
    parser.add_argument("--warm-epochs", type=int, default=12)
    parser.add_argument("--threads", type=int, default=12)
    parser.add_argument("--scan-binary", type=Path)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--steps", type=int, default=0)
    parser.add_argument("--patience", type=int, default=3)
    parser.add_argument("--resume", action="store_true")
    train(parser.parse_args())
