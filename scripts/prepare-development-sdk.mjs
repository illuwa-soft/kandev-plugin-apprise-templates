import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = process.argv[2];
if (!source || !path.isAbsolute(source)) throw new Error("KANDEV_FORMATTER_SOURCE must name the explicit development host checkout");
const sdk = path.join(await fs.realpath(source), "pluginsdk");
const api = await fs.readFile(path.join(sdk, "notification_formatter.go"), "utf8");
if (!api.includes("type NotificationFormatter interface")) throw new Error("selected SDK has no notification formatter contract");
const revision = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["-C", source, "status", "--porcelain", "--", "pluginsdk"], { encoding: "utf8" }).trim() !== "";
const build = path.join(root, ".build");
await fs.mkdir(build, { recursive: true });
const snapshot = path.join(build, "development-sdk");
await fs.rm(snapshot, { recursive: true, force: true });
await fs.cp(sdk, snapshot, { recursive: true, filter: (entry) => !path.relative(sdk, entry).split(path.sep).some((part) => [".tools", ".git"].includes(part)) });
const hash = createHash("sha256");
async function digestTree(directory, relative = "") {
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error("development SDK snapshot cannot contain symbolic links");
    if (entry.isDirectory()) await digestTree(path.join(directory, entry.name), name);
    else { hash.update(name); hash.update("\0"); hash.update(await fs.readFile(path.join(directory, entry.name))); }
  }
}
await digestTree(snapshot);
await fs.writeFile(path.join(build, "development.go.work"), `go 1.26.0\n\nuse (\n ${JSON.stringify(root)}\n ${JSON.stringify(snapshot)}\n)\n`);
const receipt = { mode: "private-unreleased-sdk", source_revision: revision, source_dirty: dirty, sdk_tree_sha256: hash.digest("hex"), public_release_verified: false };
await fs.writeFile(path.join(build, "development-sdk-receipt.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
