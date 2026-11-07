import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = process.argv[2];
assert.ok(source && path.isAbsolute(source), "Supply the absolute reviewed Kandev source checkout");
const revision = "15495808e383c0af926a617b54cd8b2adacd9db3";
const root = fileURLToPath(new URL("../", import.meta.url));
await fs.mkdir(path.join(root, ".build"), { recursive: true });
const temporary = await fs.mkdtemp(path.join(root, ".build/legacy-oracle-"));
const sources = {};
try {
  const inputs = [
    ["templates/renderer.go", "apps/backend/internal/notifications/templates/renderer.go"],
    ["templates/urls.go", "apps/backend/internal/notifications/templates/urls.go"],
    ["weburl/origin.go", "apps/backend/internal/common/weburl/origin.go"],
  ];
  for (const [output, input] of inputs) {
    const raw = execFileSync("git", ["show", `${revision}:${input}`], { cwd: source });
    sources[input] = createHash("sha256").update(raw).digest("hex");
    await fs.mkdir(path.dirname(path.join(temporary, output)), { recursive: true });
    // The sole source adaptation redirects an internal import into the isolated module.
    await fs.writeFile(path.join(temporary, output), raw.toString().replace('"github.com/kandev/kandev/internal/common/weburl"', '"oracle/weburl"'));
  }
  await fs.writeFile(path.join(temporary, "go.mod"), "module oracle\n\ngo 1.26\n");
  await fs.copyFile(path.join(root, "testdata/legacy-migration/generate.go"), path.join(temporary, "main.go"));
  const fixture = JSON.parse(execFileSync("go", ["run", ".", revision], {
    cwd: temporary, env: { ...process.env, GOWORK: "off", GOPROXY: "off" }, encoding: "utf8", timeout: 120000,
  }));
  fixture.Sources = sources;
  await fs.writeFile(path.join(root, "testdata/legacy-migration/oracle.json"), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(JSON.stringify({ source_revision: revision, render_cases: fixture.Cases.length, url_cases: fixture.URLs.length, sources }));
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
