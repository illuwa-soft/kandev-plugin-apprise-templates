import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("recovery verifier rejects mixed, corrupt, and cross-owner backup sets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "formatter-backup-set-test-"));
  try {
    const verifier = fileURLToPath(new URL("../scripts/verify-backup-set.py", import.meta.url));
    const validator = path.join(root, "validator");
    execFileSync("go", ["build", "-trimpath", "-o", validator, "./server"], { stdio: "pipe" });
    execFileSync("python3", ["-c", `
import hashlib, json, pathlib, sqlite3, subprocess, sys
root, verifier, validator = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
configuration = '{"version":1,"origin":"","templates":{}}'
digest = hashlib.sha256(configuration.encode()).hexdigest()
host = sqlite3.connect(root / 'host.db')
host.executescript('''
CREATE TABLE notification_providers(id TEXT PRIMARY KEY,user_id TEXT,type TEXT);
CREATE TABLE notification_formatter_bindings(provider_id TEXT,provider_type TEXT,plugin_id TEXT,installation_id TEXT,formatter_key TEXT,configuration_revision TEXT,digest TEXT,revision TEXT);
INSERT INTO notification_providers VALUES('mail','owner','apprise');
''')
host.execute('INSERT INTO notification_formatter_bindings VALUES(?,?,?,?,?,?,?,?)', ('mail','apprise','kandev-plugin-apprise-templates','installation','apprise-text','snapshot',digest,'binding'))
host.commit(); host.close()
plugin = sqlite3.connect(root / 'templates.db')
plugin.executescript('CREATE TABLE snapshots(owner_id TEXT,provider_id TEXT,revision TEXT,digest TEXT,configuration TEXT); PRAGMA user_version=1;')
plugin.execute('INSERT INTO snapshots VALUES(?,?,?,?,?)', ('owner','mail','snapshot',digest,configuration))
plugin.commit(); plugin.close()
manifest = {'schema':1, 'host_version':'candidate', 'plugin_version':'0.1.0', 'validator_sha256':hashlib.sha256(pathlib.Path(validator).read_bytes()).hexdigest(),
 'plugin_id':'kandev-plugin-apprise-templates', 'installation_id':'installation',
 'files':{'host_database':{'path':'host.db'},'plugin_database':{'path':'templates.db'}}}
def stamp():
    for item in manifest['files'].values():
        raw = (root / item['path']).read_bytes()
        item.update(sha256=hashlib.sha256(raw).hexdigest(), bytes=len(raw))
    (root / 'manifest.json').write_text(json.dumps(manifest))
def run(ok):
    result = subprocess.run([sys.executable,verifier,str(root / 'manifest.json'),validator], capture_output=True, text=True)
    assert (result.returncode == 0) == ok, result.stderr
    if ok:
        assert json.loads(result.stdout)['verified_bindings'] == 1
stamp(); run(True)
# A matching digest must not bless configuration the live runtime rejects.
for invalid in [
    {'version':1,'origin':'http://public.invalid','templates':{}},
    {'version':1,'origin':'','templates':{'session.failed':{'version':99,'title':'bad','body':'bad'}}},
    {'version':1,'origin':'','templates':{'session.failed':{'version':1,'title':'{{unknown.value}}','body':'bad'}}},
]:
    raw = json.dumps(invalid,separators=(',',':'))
    invalid_digest = hashlib.sha256(raw.encode()).hexdigest()
    with sqlite3.connect(root / 'templates.db') as db:
        db.execute('UPDATE snapshots SET configuration=?,digest=?',(raw,invalid_digest))
    with sqlite3.connect(root / 'host.db') as db:
        db.execute('UPDATE notification_formatter_bindings SET digest=?',(invalid_digest,))
    stamp(); run(False)
with sqlite3.connect(root / 'templates.db') as db:
    db.execute('UPDATE snapshots SET configuration=?,digest=?',(configuration,digest))
with sqlite3.connect(root / 'host.db') as db:
    db.execute('UPDATE notification_formatter_bindings SET digest=?',(digest,))
stamp(); run(True)
# A different plugin installation must never satisfy a host binding.
manifest['installation_id']='replacement'; stamp(); run(False)
manifest['installation_id']='installation'; stamp()
# Correct physical digests do not hide a foreign owner's snapshot.
with sqlite3.connect(root / 'templates.db') as db:
    db.execute("UPDATE snapshots SET owner_id='foreign'")
stamp(); run(False)
with sqlite3.connect(root / 'templates.db') as db:
    db.execute("UPDATE snapshots SET owner_id='owner', configuration='{}'")
stamp(); run(False)
with sqlite3.connect(root / 'templates.db') as db:
    db.execute('UPDATE snapshots SET configuration=?',(configuration,))
stamp(); run(True)
# Reject modified bytes and files outside the selected backup directory.
with open(root / 'templates.db','ab') as file: file.write(b'changed')
run(False)
manifest['files']['plugin_database']['path']='../outside.db'
(root / 'manifest.json').write_text(json.dumps(manifest)); run(False)
`, root, verifier, validator]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
