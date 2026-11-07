import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("capture holds one bounded lease, validates the full set, and rejects expiry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "formatter-capture-test-"));
  try {
    const script = fileURLToPath(new URL("../scripts/capture-backup-set.py", import.meta.url));
    const validator = path.join(root, "server/validator");
    await fs.mkdir(path.dirname(validator), {recursive:true});
    execFileSync("go", ["build", "-trimpath", "-o", validator, "./server"], { stdio: "pipe" });
    execFileSync("python3", ["-c", `
import datetime, hashlib, http.server, importlib.util, json, os, pathlib, sqlite3, stat, subprocess, sys, threading
from unittest import mock
root, script, validator = pathlib.Path(sys.argv[1]),sys.argv[2],sys.argv[3]
sys.dont_write_bytecode=True
configuration='{"version":1,"origin":"","templates":{}}'
digest=hashlib.sha256(configuration.encode()).hexdigest()
with sqlite3.connect(root/'host.db') as db:
    db.executescript('CREATE TABLE notification_providers(id TEXT,user_id TEXT,type TEXT); CREATE TABLE notification_formatter_bindings(provider_id TEXT,provider_type TEXT,plugin_id TEXT,installation_id TEXT,formatter_key TEXT,configuration_revision TEXT,digest TEXT,revision TEXT);')
    db.execute('INSERT INTO notification_providers VALUES(?,?,?)',('mail','owner','apprise'))
    db.execute('INSERT INTO notification_formatter_bindings VALUES(?,?,?,?,?,?,?,?)',('mail','apprise','kandev-plugin-apprise-templates','installation','apprise-text','snapshot',digest,'binding'))
with sqlite3.connect(root/'templates.db') as db:
    db.executescript('CREATE TABLE snapshots(owner_id TEXT,provider_id TEXT,revision TEXT,digest TEXT,configuration TEXT); PRAGMA user_version=1;')
    db.execute('INSERT INTO snapshots VALUES(?,?,?,?,?)',('owner','mail','snapshot',digest,configuration))
for role in ['host_binary','launcher','configuration','plugin_record','plugin_package']:
    (root/role).write_text('synthetic-private-'+role)
platform='-'.join(subprocess.check_output(['go','env','GOOS','GOARCH'],text=True).split())
record={'id':'kandev-plugin-apprise-templates','api_version':2,'version':'0.1.0','installation_id':'installation','install_path':str(root),'runtime':{'type':'binary','executables':{platform:'server/validator'}},'notification_formatters':[{'key':'apprise-text','contract_version':1,'provider_types':['apprise']}]}
(root/'plugin_record').write_text(json.dumps(record))
events=[]
expired=False
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def respond(self,value):
        raw=json.dumps(value).encode(); self.send_response(200); self.end_headers(); self.wfile.write(raw)
    def lease(self,read=False):
        future=datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=-1 if expired and read else 5)
        return {'id':'capture-fixture','expires_at':future.isoformat()}
    def do_GET(self):
        events.append(('GET',self.path))
        self.respond({'version':'candidate'} if self.path=='/health' else self.lease(True))
    def do_POST(self):
        events.append(('POST',self.path))
        self.respond({'released':True} if self.path.endswith('/release') else self.lease())
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
try:
    files={role:{'path':str(root/role),'sha256':hashlib.sha256((root/role).read_bytes()).hexdigest()} for role in ['host_binary','launcher','configuration','plugin_record','plugin_package']}
    files['plugin_binary']={'path':validator,'sha256':hashlib.sha256(pathlib.Path(validator).read_bytes()).hexdigest()}
    plan={'schema':1,'api_base_url':'http://127.0.0.1:'+str(server.server_port),'host_version':'candidate','plugin_version':'0.1.0','plugin_id':'kandev-plugin-apprise-templates','installation_id':'installation','host_database':str(root/'host.db'),'plugin_database':str(root/'templates.db'),'files':files}
    plan_file=root/'plan.json'; plan_file.write_text(json.dumps(plan))
    result=subprocess.run([sys.executable,script,str(plan_file),str(root/'complete')],capture_output=True,text=True)
    assert result.returncode==0,result.stderr
    assert (root/'complete'/'manifest.json').is_file()
    assert 'synthetic-private' not in result.stdout
    assert events.count(('POST','/api/v1/notification-formatters/capture'))==1
    assert events[-1]==('POST','/api/v1/notification-formatters/capture/capture-fixture/release')
    assert (root/'complete').stat().st_mode & 0o777 == 0o700
    spec=importlib.util.spec_from_file_location('capture_fixture',script)
    capture_module=importlib.util.module_from_spec(spec); spec.loader.exec_module(capture_module)
    original_open,original_sync=os.open,os.fsync
    opened={}; synced=[]
    def tracked_open(filename,*args,**kwargs):
        fd=original_open(filename,*args,**kwargs); opened[fd]=str(pathlib.Path(filename).resolve()); return fd
    def tracked_sync(fd):
        if stat.S_ISDIR(os.fstat(fd).st_mode): synced.append(opened[fd])
        return original_sync(fd)
    with mock.patch.object(os,'open',side_effect=tracked_open),mock.patch.object(os,'fsync',side_effect=tracked_sync):
        capture_module.capture(plan_file,root/'durable')
    assert synced[-2:]==[str((root/'durable').resolve()),str(root.resolve())],synced
    expired=True; events.clear()
    result=subprocess.run([sys.executable,script,str(plan_file),str(root/'expired')],capture_output=True,text=True)
    assert result.returncode!=0
    assert not (root/'expired'/'manifest.json').exists()
    assert events[-1]==('POST','/api/v1/notification-formatters/capture/capture-fixture/release')
    expired=False
    for mismatch in ['installation','version','executable','formatter']:
        changed=json.loads(json.dumps(record))
        if mismatch=='installation': changed['installation_id']='replacement-installation'
        if mismatch=='version': changed['version']='unsupported-version'
        if mismatch=='executable': changed['runtime']['executables'][platform]='server/different'
        if mismatch=='formatter': changed['notification_formatters'][0]['key']='different-key'
        (root/'plugin_record').write_text(json.dumps(changed))
        plan['files']['plugin_record']['sha256']=hashlib.sha256((root/'plugin_record').read_bytes()).hexdigest()
        plan_file.write_text(json.dumps(plan))
        target=root/('mixed-'+mismatch)
        result=subprocess.run([sys.executable,script,str(plan_file),str(target)],capture_output=True,text=True)
        assert result.returncode!=0,'mixed '+mismatch+' metadata was accepted'
        assert not (target/'manifest.json').exists()
finally:
    server.shutdown(); server.server_close(); thread.join()
`, root, script, validator]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
