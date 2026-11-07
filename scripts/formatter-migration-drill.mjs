import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const digest = async (file) => createHash("sha256").update(await fs.readFile(file)).digest("hex");

// All source rows and receivers belong to this caller-owned synthetic host.
export async function formatterMigrationDrill({ home, installed, providerId, json, post }) {
  const plugin = installed.plugin;
  const previous = (await json(`/api/v1/notification-providers/${providerId}/formatter`)).binding;
  const activeContext = { installationId: previous.installation_id, formatterKey: previous.formatter_key, expectedBindingRevision: previous.revision, mode: "active" };
  const probe = await post(`/api/plugins/${plugin.id}/actions/templates.export`, {
    notificationProviderId: providerId, notificationFormatter: activeContext, body: { revision: previous.configuration_revision },
  });
  const target = await post("/api/v1/notification-providers", { name: "Synthetic migration", type: "apprise", config: { urls: "json://example.invalid" }, enabled: false, events: [] });
  const source = path.join(home, "legacy-source.db");
  const events = ["session.turn_finished", "session.clarification_requested", "office.inbox_item", "system.update_available"];
  await execute("python3", ["-c", `
import json,sqlite3,sys
source,owner,provider,events=sys.argv[1:]
with sqlite3.connect(source) as db:
    db.executescript("CREATE TABLE kandev_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO kandev_meta VALUES('kandev_version','0.98.0+upstream-history.apprise-templates.1'); CREATE TABLE notification_providers(id TEXT PRIMARY KEY,user_id TEXT,type TEXT,config TEXT); CREATE TABLE notification_templates(provider_id TEXT NOT NULL REFERENCES notification_providers(id) ON DELETE CASCADE,user_id TEXT NOT NULL,event_type TEXT NOT NULL,template_json TEXT NOT NULL,revision TEXT NOT NULL,created_at TIMESTAMP NOT NULL,updated_at TIMESTAMP NOT NULL,PRIMARY KEY(provider_id,event_type));")
    db.execute('INSERT INTO notification_providers VALUES(?,?,?,?)',(provider,owner,'apprise','fixture-private-receiver'))
    for event in json.loads(events):
        raw=json.dumps({'version':1,'title':'{{event.type}}','body':'Preserved {{default.body}}'},separators=(',',':'))
        db.execute('INSERT INTO notification_templates VALUES(?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',(provider,owner,event,raw,'legacy-'+event))
`, source, probe.source_owner_id, target.id, JSON.stringify(events)]);
  const sourceDigest = await digest(source);
  const exporter = path.join(home, "legacy-export");
  await execute("go", ["build", "-trimpath", "-o", exporter, "./cmd/legacy-export"], {
    cwd: root, env: { ...process.env, GOWORK: "off" }, timeout: 120000,
  });
  const destination = path.join(home, "legacy-exported");
  await execute(exporter, ["--snapshot", source, "--output", destination, "--origin", "https://example.invalid"], { timeout: 30000 });
  const files = await fs.readdir(destination);
  assert.equal(files.length, 1);
  const content = await fs.readFile(path.join(destination, files[0]), "utf8");
  assert.ok(!content.includes("fixture-private-receiver"));
  assert.equal((await fs.stat(path.join(destination, files[0]))).mode & 0o777, 0o600);
  const document = JSON.parse(content);
  const candidate = { installationId: previous.installation_id, formatterKey: previous.formatter_key, expectedBindingRevision: "", mode: "candidate" };
  const input = { notificationProviderId: target.id, notificationFormatter: candidate, body: document };
  await assert.rejects(() => post(`/api/plugins/${plugin.id}/actions/templates.import`, {
    ...input, body: { ...document, source_owner_id: "foreign-fixture-owner" },
  }), (error) => error.status === 400);
  const prepared = await post(`/api/plugins/${plugin.id}/actions/templates.import`, input);
  assert.deepEqual(prepared.configuration, document.configuration);
  assert.equal((await post(`/api/plugins/${plugin.id}/actions/templates.import`, input)).revision, prepared.revision);
  assert.ok(!(await json(`/api/v1/notification-providers/${target.id}/formatter`)).binding?.plugin_id);
  const activated = await json(`/api/v1/notification-providers/${target.id}/formatter`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected_revision: "", binding: {
      plugin_id: plugin.id, installation_id: candidate.installationId, formatter_key: candidate.formatterKey,
      configuration_revision: prepared.revision, digest: prepared.digest,
    } }),
  });
  for (const event of events) {
    const preview = await post(`/api/v1/notification-providers/${target.id}/formatter/preview`, {
      binding: activated.binding, event, sample: "normal", draft: prepared.configuration,
    });
    assert.equal(preview.title, event);
    assert.equal(preview.used_fallback, false);
    assert.ok(preview.body.startsWith("Preserved "));
    assert.equal(prepared.configuration.source_revisions[event], `legacy-${event}`);
  }
  const after = (await json("/api/v1/notification-providers")).providers.find((provider) => provider.id === target.id);
  assert.equal(after.enabled, false);
  assert.deepEqual(after.events, []);
  assert.equal(await digest(source), sourceDigest);
  return { providerId: target.id, receipt: { imported_templates: events.length, source_sha256: sourceDigest, configuration_digest: prepared.digest,
    checks: ["offline byte-preserving export", "no receiver/config export", "idempotent owner-bound candidate import", "no binding before explicit activation", "four live synthetic previews", "subscriptions unchanged"] } };
}
