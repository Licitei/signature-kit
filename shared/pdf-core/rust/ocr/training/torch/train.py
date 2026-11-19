import argparse
import copy
import itertools
import json
import math
from pathlib import Path
import subprocess
import time

import torch
from torch import nn
from torch.optim.swa_utils import AveragedModel, get_ema_multi_avg_fn
from torch.utils.data import DataLoader

from data import Archive, batches, collate, dataset, manifest
from model import Recognizer, transcript


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
        inputs, lengths, _, _, references = batch
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


def train(args):
    torch.set_num_threads(12)
    torch.set_num_interop_threads(1)
    torch.manual_seed(args.seed)
    args.output.mkdir(parents=True, exist_ok=True)
    checkpoint = args.output / "checkpoint.pt"
    if checkpoint.exists() != args.resume:
        raise ValueError("use --resume for an existing checkpoint or choose a fresh output directory")
    paths = [Path(line) for line in args.shards.read_text().splitlines() if line]
    if len(set(paths)) != len(paths) or not paths:
        raise ValueError("the training roster must contain distinct OCRL archive paths")
    if not 0 <= args.qat < args.epochs or args.epochs < 2:
        raise ValueError("reserve at least one epoch for fp32 training")
    options = {key: value for key, value in vars(args).items() if isinstance(value, int)
               and key != "resume"}
    clean = [args.clean] if args.clean else []
    if args.real_dev.is_dir() and args.real_dev.name != "dev":
        raise ValueError("model selection requires the real development split")
    digest = manifest([("clean", clean), ("shard", paths)])
    log(args.output, event="indexing", shards=len(paths), manifest=digest)
    lines = Archive(paths, training=True)
    warm = Archive(clean, training=True) if clean else None
    real = dataset(args.real_dev)
    synthetic = dataset(args.synthetic_val)
    if len(real) != 186 or not len(synthetic) or not len(lines) or (warm is not None and not len(warm)):
        raise ValueError("training requires 186 real dev lines and nonempty synthetic datasets")
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
    model = Recognizer()
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.003, weight_decay=0.01, fused=True)
    ema = AveragedModel(model, multi_avg_fn=get_ema_multi_avg_fn(0.99))
    first_epoch = 0
    best = math.inf
    stale = 0
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if args.resume:
        state = torch.load(checkpoint, map_location="cpu", weights_only=True)
        if state["provenance"] != provenance:
            raise ValueError("checkpoint data or training schedule changed")
        model.load_state_dict(state["model"])
        optimizer.load_state_dict(state["optimizer"])
        ema.load_state_dict(state["ema"])
        first_epoch = state["epoch"]
        best = state["best"]
        stale = state["stale"]
        commit = state["commit"]
    ctc = nn.CTCLoss(blank=0, zero_infinity=False)
    log(args.output, event="ready", records=len(lines), rejected=lines.rejected,
        clean=len(warm) if warm is not None else 0, start_epoch=first_epoch,
        dev=len(real), synthetic_val=len(synthetic), seed=args.seed, commit=commit)
    available_steps = math.ceil(len(lines) / args.batch_size)
    steps = min(args.steps or available_steps, available_steps)
    for epoch in range(first_epoch, args.epochs):
        start = time.perf_counter()
        mode = "qat" if epoch >= args.epochs - args.qat else "float"
        curriculum = min(1, (epoch + 1) / 3)
        line_batches = batches(lines, args.batch_size, args.seed + epoch, curriculum, steps)
        loader = DataLoader(lines, batch_sampler=line_batches, collate_fn=collate,
                            num_workers=args.workers)
        if epoch == 0 and warm is not None:
            clean_loader = DataLoader(
                warm, batch_sampler=batches(warm, args.batch_size, args.seed, 0), collate_fn=collate
            )
            loader = itertools.chain(clean_loader, loader)
        loss_total = 0.0
        visited = 0
        updates = 0
        for step, batch in enumerate(loader):
            if batch is None:
                continue
            inputs, lengths, targets, target_lengths, texts = batch
            progress = min(1.0, (epoch + step / steps) / args.epochs)
            rate = 0.003 * min(1.0, 0.2 + 20 * progress) * (0.1 + 0.9 *
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
            atomic(args.output / "best.pt", lambda file: torch.save(copy.deepcopy(exported.state_dict()), file))
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
    parser.add_argument("--clean", type=Path)
    parser.add_argument("--synthetic-val", type=Path, required=True)
    parser.add_argument("--real-dev", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=7291)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--qat", type=int, default=2)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--steps", type=int, default=0)
    parser.add_argument("--patience", type=int, default=3)
    parser.add_argument("--resume", action="store_true")
    train(parser.parse_args())
