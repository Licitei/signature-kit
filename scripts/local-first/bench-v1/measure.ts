export type MemoryValues = Record<string, number>;
export type MemoryReader = () => MemoryValues | Promise<MemoryValues>;

export const statistics = (samples: ReadonlyArray<number>) => {
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = (p: number) => sorted[Math.ceil(sorted.length * p) - 1] ?? null;
  return { median: rank(0.5), p95: rank(0.95), min: sorted[0] ?? null, max: sorted.at(-1) ?? null };
};

export const peak = (previous: MemoryValues, current: MemoryValues): MemoryValues =>
  Object.fromEntries(
    Object.entries(current).map(([key, value]) => [key, Math.max(previous[key] ?? 0, value)]),
  );

type Case = {
  id: string;
  corpus: string;
  bytes: number;
  pages: number | null;
  iterations?: number;
  warmups?: number;
};

export const makeRecorder = (
  runtime: "node" | "chromium",
  method: string,
  memory: MemoryReader,
) => {
  const measure = async <A>(
    { iterations = 21, warmups = 3, ...metadata }: Case,
    run: () => A | Promise<A>,
  ) => {
    const samples: number[] = [];
    const before = await memory();
    let high = before;
    for (let index = 0; index < warmups + iterations; index += 1) {
      const start = performance.now();
      await run();
      if (index >= warmups) samples.push(performance.now() - start);
      high = peak(high, await memory());
    }
    const after = await memory();
    return {
      ...metadata,
      runtime,
      warmups,
      samples,
      ...statistics(samples),
      memory: { method, before, peak: peak(high, after), after },
    };
  };
  const cases: Array<Awaited<ReturnType<typeof measure>>> = [];
  const record: typeof measure = async (metadata, run) => {
    const row = await measure(metadata, run);
    cases.push(row);
    return row;
  };
  return { record, cases };
};

export type Recorder = ReturnType<typeof makeRecorder>["record"];
