import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { eventually } from "./smoke-http.mjs";

const execute = promisify(execFile);
const digest = async (file) => createHash("sha256").update(await fs.readFile(file)).digest("hex");
const script = (name) => fileURLToPath(new URL(name, import.meta.url));

// This drill restores only a caller-owned disposable home, with the same host
// binary and plugin installation. It is not an arbitrary downgrade mechanism.
export async function formatterRecoveryDrill({ home, base, binary, archive, installed, version, providerIds, json, post, stop, restart }) {
  const plugin = installed.plugin;
  const pluginRoot = path.dirname(plugin.install_path);
  const key = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`;
  const executable = path.join(plugin.install_path, plugin.runtime.executables[key]);
  const configuration = path.join(home, "config.yaml");
  try { await fs.access(configuration); }
  catch { await fs.writeFile(configuration, "{}\n", { flag: "wx", mode: 0o600 }); }
  const launcher = path.join(home, "fixture-launcher.json");
  await fs.writeFile(launcher, JSON.stringify({ binary, base, home }), { flag: "wx", mode: 0o600 });
  const beforeProviders = await json("/api/v1/notification-providers");
  const bindings = await Promise.all(providerIds.map(async (id) => (await json(`/api/v1/notification-providers/${id}/formatter`)).binding));
  assert.ok(bindings.every((binding) => binding.installation_id === bindings[0].installation_id));
  const inputs = { host_binary: binary, plugin_binary: executable, configuration, launcher,
    plugin_record: path.join(path.dirname(pluginRoot), `${plugin.id}.yml`), plugin_package: archive };
  for (const [role, file] of Object.entries(inputs)) {
    if (role !== "host_binary" && role !== "plugin_package") {
      assert.ok((await fs.realpath(file)).startsWith(`${await fs.realpath(home)}${path.sep}`), "fixture artifact escaped owned home");
    }
  }
  const files = Object.fromEntries(await Promise.all(Object.entries(inputs).map(async ([role, file]) => [role, { path: file, sha256: await digest(file) }])));
  const plan = { schema: 1, api_base_url: base, host_version: version, plugin_version: plugin.version, plugin_id: plugin.id,
    installation_id: bindings[0].installation_id, host_database: path.join(home, "host.db"),
    plugin_database: path.join(pluginRoot, "data/templates.db"), files };
  const planFile = path.join(home, "capture-plan.json");
  await fs.writeFile(planFile, JSON.stringify(plan), { flag: "wx", mode: 0o600 });
  const capture = path.join(home, "recovery-set");
  await execute("python3", [script("capture-backup-set.py"), planFile, capture], { timeout: 180000 });
  const manifest = path.join(capture, "manifest.json");
  await execute("python3", [script("verify-backup-set.py"), manifest, executable], { timeout: 60000 });

  const lease = await post("/api/v1/notification-formatters/capture", {});
  try {
    const denied = await fetch(`${base}/api/plugins/${plugin.id}/actions/templates.prepare`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notificationProviderId: providerIds[0],
        notificationFormatter: { installationId: bindings[0].installation_id, formatterKey: bindings[0].formatter_key, expectedBindingRevision: bindings[0].revision, mode: "active" },
        body: { configuration: { version: 1, origin: "", templates: {} } } }),
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(denied.status, 503);
    assert.equal((await json("/health")).version, version);
  } finally {
    await post(`/api/v1/notification-formatters/capture/${lease.id}/release`, {});
  }

  const action = async (key, body, signal) => {
    const current = (await json(`/api/v1/notification-providers/${providerIds[0]}/formatter`, {signal})).binding;
    return post(`/api/plugins/${plugin.id}/actions/templates.${key}`, { notificationProviderId: providerIds[0],
      notificationFormatter: { installationId: current.installation_id, formatterKey: current.formatter_key, expectedBindingRevision: current.revision, mode: "active" }, body }, signal);
  };
  const original = await action("export", { revision: bindings[0].configuration_revision });
  const later = structuredClone(original.configuration);
  later.templates["session.failed"] = { version: 1, title: "Later edit retained", body: "Synthetic recovery drill" };
  const saved = await action("prepare", { configuration: later });
  const edited = await json(`/api/v1/notification-providers/${providerIds[0]}/formatter`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_revision: bindings[0].revision, binding: { ...bindings[0], configuration_revision: saved.revision, digest: saved.digest } }),
  });
  assert.equal(edited.binding.configuration_revision, saved.revision);
  const retained = await action("export", { revision: saved.revision, target: "legacy-v1" });
  assert.equal(retained.current.configuration.templates["session.failed"].title, "Later edit retained");
  assert.equal(Object.keys(retained.current.configuration.templates).length, 6);
  assert.equal(Object.keys(retained.legacy.configuration.templates).length, 4);
  const exportFile = path.join(home, "later-edits.json");
  await fs.writeFile(exportFile, JSON.stringify(retained), { flag: "wx", mode: 0o600 });
  const exportDigest = await digest(exportFile);

  await stop();
  await execute("python3", [script("verify-backup-set.py"), manifest, executable], { timeout: 60000 });
  // Quarantine the entire fixture generation, including sidecars, before copying.
  for (const [role, destination] of [["host_database", plan.host_database], ["plugin_database", plan.plugin_database]]) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try { await fs.rename(destination + suffix, destination + suffix + ".before-restore"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const metadata = JSON.parse(await fs.readFile(manifest, "utf8")).files[role];
    await fs.copyFile(path.join(capture, metadata.path), destination, fs.constants.COPYFILE_EXCL);
    await fs.chmod(destination, 0o600);
  }
  await restart();
  for (let index = 0; index < providerIds.length; index++) {
    const restored = (await json(`/api/v1/notification-providers/${providerIds[index]}/formatter`)).binding;
    assert.deepEqual(restored, bindings[index]);
  }
  assert.deepEqual(await json("/api/v1/notification-providers"), beforeProviders);
  let restored;
  await eventually(async (signal) => {
    // Export is a read-only immutable-revision probe, not a mutation retry.
    restored = await action("export", { revision: bindings[0].configuration_revision }, signal);
    return true;
  }, "restored plugin process did not become available");
  assert.deepEqual(restored.configuration, original.configuration);
  assert.equal(await digest(exportFile), exportDigest);
  return { verified_bindings: bindings.length, later_edit_export_sha256: exportDigest,
    checks: ["coherent live capture under bounded lease", "configuration writes denied while health remains available", "six-event later-edit export with four-event rollback projection", "same-candidate host/plugin database restore and exact binding readback"] };
}
