import { createReadStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { PubkyShopError } from "./errors.js";

export interface ExternalSortLimits {
  readonly maxLineBytes: number;
  readonly maxWorkingSetBytes: number;
}

export interface ExternalSortResult {
  readonly path: string;
  readonly peakBufferedBytes: number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function plannerLimit(maximum: number, observed: number): never {
  throw new PubkyShopError("limit_exceeded", {
    field: "planner_working_set_bytes",
    limit: maximum,
    observed: Math.min(observed, maximum + 1),
  });
}

export async function* readBoundedLines(
  path: string,
  maxLineBytes: number,
): AsyncGenerator<string> {
  const input = createReadStream(path, {
    encoding: "utf8",
    highWaterMark: 64 * 1024,
  });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      const bytes = Buffer.byteLength(line);
      if (bytes > maxLineBytes) {
        throw new PubkyShopError("limit_exceeded", {
          field: "planner_external_line_bytes",
          limit: maxLineBytes,
          observed: Math.min(bytes, maxLineBytes + 1),
        });
      }
      yield line;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

async function writeLines(path: string, lines: readonly string[]): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    for (const line of lines) {
      await handle.writeFile(`${line}\n`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function mergeRuns(
  paths: readonly string[],
  output: string,
  limits: ExternalSortLimits,
): Promise<number> {
  const iterators = paths.map((path) =>
    readBoundedLines(path, limits.maxLineBytes)[Symbol.asyncIterator](),
  );
  const current: Array<string | undefined> = new Array(iterators.length);
  let peak = 0;
  for (let index = 0; index < iterators.length; index += 1) {
    const item = await iterators[index]?.next();
    current[index] = item?.done === false ? item.value : undefined;
  }
  const handle = await open(output, "wx", 0o600);
  try {
    while (true) {
      let selected = -1;
      let selectedLine: string | undefined;
      let charged = 0;
      for (let index = 0; index < current.length; index += 1) {
        const line = current[index];
        if (line === undefined) {
          continue;
        }
        charged += Buffer.byteLength(line) * 2 + 16;
        if (selectedLine === undefined || compareText(line, selectedLine) < 0) {
          selected = index;
          selectedLine = line;
        }
      }
      peak = Math.max(peak, charged);
      if (charged > limits.maxWorkingSetBytes) {
        plannerLimit(limits.maxWorkingSetBytes, charged);
      }
      if (selected < 0 || selectedLine === undefined) {
        break;
      }
      await handle.writeFile(`${selectedLine}\n`);
      const item = await iterators[selected]?.next();
      current[selected] = item?.done === false ? item.value : undefined;
    }
    await handle.sync();
  } finally {
    await handle.close();
    await Promise.all(iterators.map((iterator) => iterator.return?.(undefined)));
  }
  return peak;
}

/**
 * Stable external merge sort. Run buffers and merge fan-in are derived from
 * the caller's working-set budget; no run or complete index is retained.
 */
export async function externalSortLines(
  input: string,
  workspace: string,
  stem: string,
  limits: ExternalSortLimits,
): Promise<ExternalSortResult> {
  if (
    !Number.isSafeInteger(limits.maxLineBytes) ||
    limits.maxLineBytes < 1 ||
    !Number.isSafeInteger(limits.maxWorkingSetBytes) ||
    limits.maxWorkingSetBytes < 64 * 1024
  ) {
    throw new PubkyShopError("invalid_configuration", {
      field: "maxWorkingSetBytes",
    });
  }
  const runBudget = Math.max(
    64 * 1024,
    Math.min(Math.floor(limits.maxWorkingSetBytes / 3), limits.maxWorkingSetBytes),
  );
  const runs: string[] = [];
  let lines: string[] = [];
  let charged = 0;
  let peak = 0;

  const flush = async (): Promise<void> => {
    if (lines.length === 0) {
      return;
    }
    lines.sort(compareText);
    peak = Math.max(peak, charged);
    const path = join(workspace, `${stem}.run.${runs.length}`);
    await writeLines(path, lines);
    runs.push(path);
    lines = [];
    charged = 0;
  };

  for await (const line of readBoundedLines(input, limits.maxLineBytes)) {
    const lineCharge = Buffer.byteLength(line) * 2 + 16;
    if (lineCharge > limits.maxWorkingSetBytes) {
      plannerLimit(limits.maxWorkingSetBytes, lineCharge);
    }
    if (lines.length > 0 && charged + lineCharge > runBudget) {
      await flush();
    }
    lines.push(line);
    charged += lineCharge;
  }
  await flush();

  if (runs.length === 0) {
    const empty = join(workspace, `${stem}.sorted`);
    await writeLines(empty, []);
    return { path: empty, peakBufferedBytes: 0 };
  }

  const perLineCharge = limits.maxLineBytes * 2 + 16;
  const fanIn = Math.max(
    2,
    Math.min(16, Math.floor(limits.maxWorkingSetBytes / Math.max(1, perLineCharge))),
  );
  let generation = 0;
  let active = runs;
  while (active.length > 1) {
    const next: string[] = [];
    for (let offset = 0; offset < active.length; offset += fanIn) {
      const group = active.slice(offset, offset + fanIn);
      if (group.length === 1) {
        next.push(group[0] as string);
        continue;
      }
      const output = join(workspace, `${stem}.merge.${generation}.${next.length}`);
      peak = Math.max(peak, await mergeRuns(group, output, limits));
      await Promise.all(group.map((path) => rm(path, { force: true })));
      next.push(output);
    }
    generation += 1;
    active = next;
  }
  return { path: active[0] as string, peakBufferedBytes: peak };
}
