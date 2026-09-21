import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { usage } from "./exit.js";

export type CommandSpec = {
  readonly name: string;
  readonly summary: string;
  readonly flags: readonly string[];
};

export const GLOBAL_FLAGS: readonly string[] = [
  "--json",
  "--bff-url <origin>",
  "--service-url <origin>",
  "--help, -h",
  "--version",
];

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "auth login",
    summary: "Start or complete marketplace login",
    flags: [
      "--complete",
      "--print-url",
      "--stop-after-qr",
      "--qr-path <path>",
      "--json",
      "--bff-url <origin>",
      "--service-url <origin>",
    ],
  },
  {
    name: "auth status",
    summary: "Show the stored marketplace bearer",
    flags: ["--json", "--bff-url <origin>", "--service-url <origin>"],
  },
  {
    name: "auth logout",
    summary: "Revoke the marketplace session and drop the local bearer",
    flags: ["--force-local", "--json", "--bff-url <origin>", "--service-url <origin>"],
  },
  {
    name: "listings export",
    summary: "Export seller listings",
    flags: [
      "--format <csv|json>",
      "--output <path>",
      "--json",
      "--bff-url <origin>",
      "--service-url <origin>",
    ],
  },
  {
    name: "listings import",
    summary: "Import listings and sync them to the service",
    flags: [
      "--input <path>",
      "--format <csv|json>",
      "--json",
      "--bff-url <origin>",
      "--service-url <origin>",
    ],
  },
  {
    name: "orders export",
    summary: "Export seller orders",
    flags: ["--cursor <token>", "--json", "--bff-url <origin>", "--service-url <origin>"],
  },
  {
    name: "events tail",
    summary: "Tail seller events",
    flags: ["--cursor <token>", "--json", "--bff-url <origin>", "--service-url <origin>"],
  },
  {
    name: "webhook add",
    summary: "Register a webhook",
    flags: ["--url <https-url>", "--json", "--bff-url <origin>", "--service-url <origin>"],
  },
  {
    name: "webhook rotate",
    summary: "Rotate a webhook secret",
    flags: ["--id <webhook-id>", "--json", "--bff-url <origin>", "--service-url <origin>"],
  },
  {
    name: "webhook delete",
    summary: "Delete a webhook",
    flags: ["--id <webhook-id>", "--json", "--bff-url <origin>", "--service-url <origin>"],
  },
];

export function packageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, "package.json");
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name === "@bitcoinerrorlog/pubky-shop" && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // walk up
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw usage("package version unavailable");
}

export function formatHelp(command: readonly string[] = []): string {
  const lines: string[] = [];
  if (command.length > 0) {
    lines.push(`Usage: pubky-shop ${command.join(" ")} [flags]`);
  } else {
    lines.push("Usage: pubky-shop <command> [flags]");
  }
  lines.push("");
  lines.push("Commands:");
  for (const spec of COMMANDS) {
    lines.push(`  ${spec.name}`);
    lines.push(`    ${spec.summary}`);
    lines.push(`    flags: ${spec.flags.join(" ")}`);
  }
  lines.push("");
  lines.push("Global flags:");
  for (const flag of GLOBAL_FLAGS) {
    lines.push(`  ${flag}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}
