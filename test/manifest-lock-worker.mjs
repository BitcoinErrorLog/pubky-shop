import { PubkyShopError } from "../.test-dist/src/index.js";
import { FileManifestStore } from "../.test-dist/src/node.js";

const [directory, manifestId] = process.argv.slice(2);
if (directory === undefined || manifestId === undefined) {
  process.exitCode = 3;
} else {
  const store = new FileManifestStore(directory);
  try {
    await store.compareAndSwap(manifestId, 1, (manifest) => ({
      ...manifest,
      manifestVersion: 2,
      rows: manifest.rows.map((row) => ({ ...row, checkpoint: "publishing" })),
    }));
    process.exitCode = 0;
  } catch (error) {
    process.exitCode =
      error instanceof PubkyShopError && error.code === "manifest_conflict" ? 2 : 3;
  }
}
