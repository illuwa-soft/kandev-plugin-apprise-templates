import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("native SQLite capture preserves the source and refuses target replacement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "formatter-snapshot-test-"));
  try {
    const source = path.join(root, "source.db");
    const target = path.join(root, "snapshot.db");
    execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE fixture(value TEXT)'); c.execute(\"INSERT INTO fixture VALUES('literal-data')\"); c.commit(); c.close()", source]);
    const before = createHash("sha256").update(await fs.readFile(source)).digest("hex");
    const script = fileURLToPath(new URL("../scripts/snapshot-sqlite.py", import.meta.url));
    const receipt = JSON.parse(execFileSync("python3", [script, source, target], { encoding: "utf8" }));
    assert.equal(receipt.integrity, "ok");
    assert.equal(receipt.sha256, createHash("sha256").update(await fs.readFile(target)).digest("hex"));
    assert.equal(before, createHash("sha256").update(await fs.readFile(source)).digest("hex"));
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
    assert.throws(() => execFileSync("python3", [script, source, target], { stdio: "pipe" }));
    assert.equal(receipt.sha256, createHash("sha256").update(await fs.readFile(target)).digest("hex"));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("capture includes committed WAL pages while the source connection stays open", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "formatter-wal-test-"));
  try {
    const script = fileURLToPath(new URL("../scripts/snapshot-sqlite.py", import.meta.url));
    execFileSync("python3", ["-c", `
import hashlib, pathlib, sqlite3, subprocess, sys
source, target, script = sys.argv[1:]
c = sqlite3.connect(source)
c.execute('PRAGMA journal_mode=WAL')
c.execute('CREATE TABLE fixture(value TEXT)')
c.execute("INSERT INTO fixture VALUES('committed-in-wal')")
c.commit()
files = [pathlib.Path(source), pathlib.Path(source + '-wal')]
before = [hashlib.sha256(p.read_bytes()).hexdigest() for p in files]
subprocess.run([sys.executable, script, source, target], check=True, capture_output=True)
assert before == [hashlib.sha256(p.read_bytes()).hexdigest() for p in files]
with sqlite3.connect(target) as copy:
    assert copy.execute('SELECT value FROM fixture').fetchall() == [('committed-in-wal',)]
c.close()
`, path.join(root, "source.db"), path.join(root, "snapshot.db"), script]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("invalid input leaves no snapshot and does not replace a symlink", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "formatter-invalid-test-"));
  try {
    const script = fileURLToPath(new URL("../scripts/snapshot-sqlite.py", import.meta.url));
    const source = path.join(root, "invalid.db");
    const target = path.join(root, "snapshot.db");
    const run = () => execFileSync("python3", [script, source, target], { stdio: "pipe" });
    assert.throws(run);
    await fs.writeFile(source, "not a database");
    assert.throws(run);
    await assert.rejects(fs.stat(target), { code: "ENOENT" });
    await fs.symlink(source, target);
    assert.throws(run);
    assert.equal(await fs.readlink(target), source);
    assert.equal(await fs.readFile(source, "utf8"), "not a database");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
