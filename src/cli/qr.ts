import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export async function writeQrPng(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const mod = (await import("qrcode")) as {
    toFile?: (path: string, text: string, options: object) => Promise<void>;
    default?: { toFile: (path: string, text: string, options: object) => Promise<void> };
  };
  const toFile = mod.toFile ?? mod.default?.toFile;
  if (!toFile) {
    throw new Error("qrcode.toFile is unavailable");
  }
  await toFile(filePath, text, { type: "png", width: 512, margin: 2 });
}

export async function openUrl(url: string, platform: string): Promise<void> {
  if (platform !== "darwin") {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("open", [url], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", () => resolve());
  });
}
