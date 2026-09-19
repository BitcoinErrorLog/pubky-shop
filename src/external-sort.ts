import { createReadStream } from "node:fs";
import { open, opendir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { PubkyShopError } from "./errors.js";

export const EXTERNAL_SORT_STREAM_OVERHEAD_BYTES = 64 * 1024;
export const DEFAULT_EXTERNAL_SORT_MAX_OPEN_FILES = 16;

const ITERATOR_METADATA_BYTES = 256;
const OUTPUT_METADATA_BYTES = 256;
const PATH_METADATA_BYTES = 64;
const MAX_MERGE_FAN_IN = 16;

export interface ExternalSortLimits {
  readonly maxLineBytes: number;
  readonly maxWorkingSetBytes: number;
  readonly maxOpenFiles?: number;
}

export interface ExternalSortResult {
  readonly path: string;
  readonly peakBufferedBytes: number;
  readonly peakMetadataBytes: number;
  readonly peakOpenFiles: number;
  readonly initialRunCount: number;
  readonly mergePasses: number;
  readonly mergeFanIn: number;
}

export interface ExternalSortProgress {
  readonly generation: number;
  readonly group: number;
  readonly inputCount: number;
}

export interface ExternalSortOptions {
  /**
   * Bounded progress hook. It is also the deterministic fault-injection seam
   * used by cleanup tests; callback-owned memory is outside the sorter.
   */
  readonly onMergeGroup?: (progress: ExternalSortProgress) => void | Promise<void>;
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

function pathCharge(path: string): number {
  return Buffer.byteLength(path) * 2 + PATH_METADATA_BYTES;
}

function headCharge(lineBytes: number): number {
  return lineBytes * 2 + 16;
}

function streamCharge(path: string, lineBytes: number): number {
  return (
    EXTERNAL_SORT_STREAM_OVERHEAD_BYTES +
    ITERATOR_METADATA_BYTES +
    pathCharge(path) +
    headCharge(lineBytes)
  );
}

function generatedPath(workspace: string, stem: string, generation: number, index: number): string {
  return join(workspace, `${stem}.g${generation}.${index}`);
}

function longestGeneratedPath(workspace: string, stem: string): string {
  return generatedPath(workspace, stem, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
}

export function minimumExternalSortWorkingSetBytes(
  maxLineBytes: number,
  workspace: string,
  stem: string,
): number {
  const path = longestGeneratedPath(workspace, stem);
  return OUTPUT_METADATA_BYTES + pathCharge(path) + streamCharge(path, maxLineBytes) * 2;
}

export function maximumExternalSortLineBytes(
  maxWorkingSetBytes: number,
  workspace: string,
  stem: string,
): number {
  const path = longestGeneratedPath(workspace, stem);
  const fixed =
    OUTPUT_METADATA_BYTES +
    pathCharge(path) +
    (EXTERNAL_SORT_STREAM_OVERHEAD_BYTES + ITERATOR_METADATA_BYTES + pathCharge(path) + 16) * 2;
  return Math.floor((maxWorkingSetBytes - fixed) / 4);
}

async function mergeRuns(
  paths: readonly string[],
  output: string,
  limits: ExternalSortLimits,
): Promise<{ readonly peak: number; readonly metadata: number }> {
  const iterators = paths.map((path) =>
    readBoundedLines(path, limits.maxLineBytes)[Symbol.asyncIterator](),
  );
  const current: Array<string | undefined> = new Array(iterators.length);
  const fixedMetadata =
    OUTPUT_METADATA_BYTES +
    pathCharge(output) +
    paths.reduce((total, path) => total + ITERATOR_METADATA_BYTES + pathCharge(path) + 16, 0) +
    current.length * 16;
  let peak = 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    for (let index = 0; index < iterators.length; index += 1) {
      const item = await iterators[index]?.next();
      current[index] = item?.done === false ? item.value : undefined;
    }
    handle = await open(output, "wx", 0o600);
    while (true) {
      let selected = -1;
      let selectedLine: string | undefined;
      let charged = fixedMetadata + paths.length * EXTERNAL_SORT_STREAM_OVERHEAD_BYTES;
      for (let index = 0; index < current.length; index += 1) {
        const line = current[index];
        if (line === undefined) {
          continue;
        }
        charged += headCharge(Buffer.byteLength(line));
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
    await handle?.close().catch(() => undefined);
    await Promise.all(iterators.map((iterator) => iterator.return?.(undefined)));
  }
  return { peak, metadata: fixedMetadata };
}

async function cleanupGeneratedRuns(workspace: string, stem: string): Promise<void> {
  const directory = await opendir(workspace);
  for await (const entry of directory) {
    if (
      entry.isFile() &&
      (entry.name.startsWith(`${stem}.g`) ||
        entry.name === `${stem}.sorted` ||
        entry.name.startsWith(`._${stem}.g`) ||
        entry.name === `._${stem}.sorted`)
    ) {
      await rm(join(workspace, entry.name), { force: true });
    }
  }
}

/**
 * Stable external merge sort. Generated runs are addressed by generation and
 * numeric index, so no catalog-sized pathname array or run manifest is ever
 * retained. Fan-in is bounded independently by bytes and open descriptors.
 */
export async function externalSortLines(
  input: string,
  workspace: string,
  stem: string,
  limits: ExternalSortLimits,
  options: ExternalSortOptions = {},
): Promise<ExternalSortResult> {
  const maxOpenFiles = limits.maxOpenFiles ?? DEFAULT_EXTERNAL_SORT_MAX_OPEN_FILES;
  if (
    !Number.isSafeInteger(limits.maxLineBytes) ||
    limits.maxLineBytes < 1 ||
    !Number.isSafeInteger(limits.maxWorkingSetBytes) ||
    limits.maxWorkingSetBytes < 1 ||
    !Number.isSafeInteger(maxOpenFiles) ||
    maxOpenFiles < 3 ||
    maxOpenFiles > 1024 ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(stem)
  ) {
    throw new PubkyShopError("invalid_configuration", {
      field: "externalSortLimits",
    });
  }
  const longestPath = longestGeneratedPath(workspace, stem);
  const fixedMergeBytes = OUTPUT_METADATA_BYTES + pathCharge(longestPath);
  const perMergeInputBytes = streamCharge(longestPath, limits.maxLineBytes);
  const fanInByBytes = Math.floor(
    (limits.maxWorkingSetBytes - fixedMergeBytes) / perMergeInputBytes,
  );
  const fanInByFiles = maxOpenFiles - 1;
  const fanIn = Math.min(MAX_MERGE_FAN_IN, fanInByBytes, fanInByFiles);
  if (fanIn < 2) {
    throw new PubkyShopError("invalid_configuration", {
      field: "maxWorkingSetBytes",
    });
  }

  const inputFixedBytes =
    EXTERNAL_SORT_STREAM_OVERHEAD_BYTES + ITERATOR_METADATA_BYTES + pathCharge(input);
  const outputFixedBytes = OUTPUT_METADATA_BYTES + pathCharge(longestPath);
  const runBudget = limits.maxWorkingSetBytes - inputFixedBytes - outputFixedBytes;
  if (runBudget < headCharge(limits.maxLineBytes)) {
    throw new PubkyShopError("invalid_configuration", {
      field: "maxWorkingSetBytes",
    });
  }

  let runCount = 0;
  let lines: string[] = [];
  let charged = 0;
  let lineMetadata = 0;
  let peak = 0;
  let peakMetadata =
    ITERATOR_METADATA_BYTES + pathCharge(input) + OUTPUT_METADATA_BYTES + pathCharge(longestPath);
  let peakOpenFiles = 1;

  const flush = async (): Promise<void> => {
    if (lines.length === 0) {
      return;
    }
    lines.sort(compareText);
    peak = Math.max(peak, inputFixedBytes + outputFixedBytes + charged);
    const path = generatedPath(workspace, stem, 0, runCount);
    await writeLines(path, lines);
    peakOpenFiles = Math.max(peakOpenFiles, 2);
    runCount += 1;
    if (!Number.isSafeInteger(runCount)) {
      throw new PubkyShopError("limit_exceeded", {
        field: "planner_external_runs",
        limit: Number.MAX_SAFE_INTEGER,
        observed: Number.MAX_SAFE_INTEGER,
      });
    }
    lines = [];
    charged = 0;
    lineMetadata = 0;
  };

  try {
    for await (const line of readBoundedLines(input, limits.maxLineBytes)) {
      const lineBytes = Buffer.byteLength(line);
      const lineCharge = headCharge(lineBytes);
      if (lineCharge > runBudget) {
        plannerLimit(limits.maxWorkingSetBytes, inputFixedBytes + outputFixedBytes + lineCharge);
      }
      if (lines.length > 0 && charged + lineCharge > runBudget) {
        await flush();
      }
      lines.push(line);
      charged += lineCharge;
      lineMetadata += 16;
      peakMetadata = Math.max(
        peakMetadata,
        ITERATOR_METADATA_BYTES +
          pathCharge(input) +
          OUTPUT_METADATA_BYTES +
          pathCharge(longestPath) +
          lineMetadata,
      );
      peak = Math.max(peak, inputFixedBytes + charged);
    }
    await flush();

    if (runCount === 0) {
      const empty = join(workspace, `${stem}.sorted`);
      await writeLines(empty, []);
      return {
        path: empty,
        peakBufferedBytes: outputFixedBytes,
        peakMetadataBytes: outputFixedBytes,
        peakOpenFiles: 1,
        initialRunCount: 0,
        mergePasses: 0,
        mergeFanIn: fanIn,
      };
    }

    const initialRunCount = runCount;
    let generation = 0;
    let activeCount = runCount;
    while (activeCount > 1) {
      let nextCount = 0;
      for (let offset = 0; offset < activeCount; offset += fanIn) {
        const groupSize = Math.min(fanIn, activeCount - offset);
        const output = generatedPath(workspace, stem, generation + 1, nextCount);
        await options.onMergeGroup?.({
          generation,
          group: nextCount,
          inputCount: groupSize,
        });
        if (groupSize === 1) {
          const source = generatedPath(workspace, stem, generation, offset);
          peakMetadata = Math.max(
            peakMetadata,
            pathCharge(source) + pathCharge(output) + OUTPUT_METADATA_BYTES,
          );
          await rename(source, output);
        } else {
          const group = Array.from({ length: groupSize }, (_, index) =>
            generatedPath(workspace, stem, generation, offset + index),
          );
          const merged = await mergeRuns(group, output, limits);
          peak = Math.max(peak, merged.peak);
          peakMetadata = Math.max(peakMetadata, merged.metadata);
          peakOpenFiles = Math.max(peakOpenFiles, groupSize + 1);
          for (const path of group) {
            await rm(path, { force: true });
          }
        }
        nextCount += 1;
      }
      generation += 1;
      activeCount = nextCount;
    }
    const finalPath = generatedPath(workspace, stem, generation, 0);
    const sortedPath = join(workspace, `${stem}.sorted`);
    await rename(finalPath, sortedPath);
    return {
      path: sortedPath,
      peakBufferedBytes: peak,
      peakMetadataBytes: peakMetadata,
      peakOpenFiles,
      initialRunCount,
      mergePasses: generation,
      mergeFanIn: fanIn,
    };
  } catch (error) {
    await cleanupGeneratedRuns(workspace, stem).catch(() => undefined);
    throw error;
  }
}
