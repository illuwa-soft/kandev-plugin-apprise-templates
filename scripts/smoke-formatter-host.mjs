// Owns a disposable backend and browser. All providers stay disabled and unsubscribed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";
import { request, eventually } from "./smoke-http.mjs";
import { formatterRecoveryDrill } from "./formatter-recovery-drill.mjs";
import { formatterMigrationDrill } from "./formatter-migration-drill.mjs";

const [binary, webDist, archive, mode] = process.argv.slice(2);
assert.ok(mode === undefined || mode === "reject", "Unknown smoke mode");
assert.ok(webDist === "-" || (webDist && path.isAbsolute(webDist)), "Use ABS_WEB_DIST or - for embedded release assets");
for (const filename of [binary, ...(webDist === "-" ? [] : [webDist]), archive]) {
  assert.ok(filename && path.isAbsolute(filename), "Usage: node scripts/smoke-formatter-host.mjs ABS_BINARY ABS_WEB_DIST_OR_DASH ABS_PACKAGE");
  await fs.stat(filename);
}
assert.equal(await fs.realpath(process.cwd()), await fs.realpath(fileURLToPath(new URL("../",import.meta.url))), "Run the smoke runner from the plugin repository root");
const lane = process.env.KANDEV_FORMATTER_EVIDENCE_LANE ?? "";
assert.match(lane,/^[a-z0-9_-]*$/);
const output = path.resolve(".build/formatter-browser",lane);
await fs.mkdir(output, { recursive: true });
const screenshots = process.env.KANDEV_FORMATTER_CAPTURE_DOCS === "1" ? path.resolve("docs/images/formatter") : output;
await fs.mkdir(screenshots,{recursive:true});
const home = await fs.mkdtemp(path.join(output, "host-"));
await fs.chmod(home, 0o700);
const allocate = async () => {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
};
const port = await allocate();
const agentPort = await allocate();
const base = `http://127.0.0.1:${port}`;
const environment = {
    PATH: `${path.dirname(binary)}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: home, LANG: "en_US.UTF-8", TMPDIR: process.env.TMPDIR ?? "/tmp",
    KANDEV_HOME_DIR: home, KANDEV_DATABASE_PATH: path.join(home, "host.db"),
    KANDEV_SERVER_HOST: "127.0.0.1", KANDEV_SERVER_PORT: String(port),
    ...(webDist === "-" ? {} : { KANDEV_WEB_DIST_DIR: webDist }),
    KANDEV_E2E_MOCK: "true", KANDEV_DOCKER_ENABLED: "false",
    AGENTCTL_PORT: String(agentPort),
};
let child;
let closed;
let processError;
let logs = "";
function start() {
  processError = undefined;
  child = spawn(binary, ["__backend"], { cwd: home, detached: true, stdio: ["ignore", "pipe", "pipe"], env: environment });
  child.on("error", (error) => { processError = error; });
  closed = once(child, "close");
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { logs = (logs + data).slice(-1024 * 1024); });
}
async function stop() {
  if (!child?.pid || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null) process.kill(-child.pid, "SIGKILL");
  }, 10000);
  try { await closed; } finally { clearTimeout(timer); }
}
async function ready() {
  await eventually(async (signal) => {
    if (processError) throw processError;
    assert.equal(child.exitCode, null, "disposable backend exited");
    return (await request(base, "/ready", { signal })).ok;
  }, "disposable host readiness", { timeoutMs: 30000 });
}
start();
const json = async (route, options) => (await request(base, route, options)).json();
const post = (route, body, signal) => json(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
const checks = [];
let browser;
let currentPage;
const browserErrors = [];
try {
  await ready();
  const health = await json("/health");
  if (process.env.KANDEV_FORMATTER_EXPECT_HOST_VERSION) {
    assert.equal(health.version, process.env.KANDEV_FORMATTER_EXPECT_HOST_VERSION, "official minimum host version");
  }
  const form = new FormData();
  form.set("package", new Blob([await fs.readFile(archive)]), "formatter.tar.gz");
  if (mode === "reject") {
    const response = await fetch(`${base}/api/plugins/install`, {method:"POST",body:form,signal:AbortSignal.timeout(30000)});
    const reason = await response.text();
    assert.ok(response.status >= 400 && response.status < 500, "unsupported host accepted the formatter package");
    assert.match(reason,/notification_provider|resource.scope|notification.formatter/i);
    const receipt={mode:"unmodified-stable-source-rejection",host_version:health.version,
      host_sha256:createHash("sha256").update(await fs.readFile(binary)).digest("hex"),
      package_sha256:createHash("sha256").update(await fs.readFile(archive)).digest("hex"),
      status:response.status,check:"formatter manifest rejected before activation"};
    await fs.writeFile(path.join(output,"unsupported-receipt.json"),JSON.stringify(receipt,null,2),{mode:0o600});
    console.log(JSON.stringify(receipt,null,2));
  } else {
  const installed = await json("/api/plugins/install", { method: "POST", body: form });
  assert.equal(installed.plugin.status, "active");
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
  const errors = [];
  const providerIds = [];
  for (const device of ["desktop", "phone"]) {
    const context = await browser.newContext(device === "phone" ? devices["Pixel 5"] : { viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    currentPage = page;
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => { errors.push(error.message); browserErrors.push(error.message); });
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    const provider = await post("/api/v1/notification-providers", {
      name: `Synthetic ${device}`, type: "apprise", config: { urls: "json://example.invalid" }, enabled: false, events: [],
    });
    providerIds.push(provider.id);
    await page.goto(`${base}/settings/preferences/notifications`, { waitUntil: "domcontentloaded" });
    const row = page.getByTestId(`notification-formatter-${provider.id}`);
    await row.locator("select").selectOption({ label: "kandev-plugin-apprise-templates / apprise-text (0.1.0)" });
    const editor = row.getByTestId("apprise-template-editor");
    await editor.getByTestId("apprise-template-event").selectOption("session.failed");
    await editor.getByTestId("apprise-template-title").fill("Synthetic {{event.type}}");
    await editor.getByTestId("apprise-template-body").fill("Literal body {{default.body}}");
    await editor.getByRole("button", { name: "Preview", exact: true }).click();
    await editor.getByTestId("apprise-template-preview").getByText(/Synthetic session.failed/).waitFor();
    for (const event of ["session.turn_finished", "session.clarification_requested", "session.permission_requested", "office.inbox_item", "system.update_available"]) {
      await editor.getByTestId("apprise-template-event").selectOption(event);
      await editor.getByTestId("apprise-template-title").fill("Synthetic {{event.type}}");
      await editor.getByTestId("apprise-template-body").fill("Literal body {{default.body}}");
      await editor.getByRole("button", { name: "Preview", exact: true }).click();
      await editor.getByTestId("apprise-template-preview").getByText(new RegExp(`Synthetic ${event.replaceAll(".", "\\.")}`)).waitFor();
    }
    await editor.getByTestId("apprise-template-event").selectOption("session.failed");
    await editor.getByTestId("apprise-template-body").fill("{{session.url}}");
    await editor.getByTestId("apprise-template-sample").selectOption("missing_url");
    await editor.getByRole("button", { name: "Preview", exact: true }).click();
    await editor.getByTestId("apprise-template-preview").getByText("The original notification content is used.", { exact: true }).waitFor();
    assert.ok(!(await editor.getByTestId("apprise-template-preview").innerText()).includes("Synthetic session.failed"));
    await editor.getByTestId("apprise-template-sample").selectOption("normal");
    await editor.getByTestId("apprise-template-body").fill("Literal body {{default.body}}");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await editor.getByText("Configuration is saved but not active. Activate it explicitly.", { exact: true }).waitFor();
    assert.ok(!(await json(`/api/v1/notification-providers/${provider.id}/formatter`)).binding?.plugin_id);
    await editor.getByRole("button", { name: "Activate prepared configuration", exact: true }).click();
    await editor.getByText("Configuration is active.", { exact: true }).waitFor();
    const active = (await json(`/api/v1/notification-providers/${provider.id}/formatter`)).binding;
    assert.equal(active.plugin_id, "kandev-plugin-apprise-templates");
    await page.reload({ waitUntil: "domcontentloaded" });
    await editor.getByTestId("apprise-template-title").waitFor();
    await editor.getByTestId("apprise-template-event").selectOption("session.failed");
    assert.equal(await editor.getByTestId("apprise-template-title").inputValue(), "Synthetic {{event.type}}");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${device} horizontal overflow`);
    if (device === "phone") {
      const box = await editor.getByRole("button", { name: "Preview", exact: true }).boundingBox();
      assert.ok(box.height >= 44, "phone preview touch height");
    }
    await editor.getByRole("heading", { name: "Apprise templates", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(screenshots, `${device}.png`) });
    await editor.getByRole("button",{name:"Preview",exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(screenshots,`${device}-controls.png`)});
    await editor.getByRole("button", { name: "Restore default on Save", exact: true }).click();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await eventually(async () => (await json(`/api/v1/notification-providers/${provider.id}/formatter`)).binding.configuration_revision !== active.configuration_revision, "restore creates and activates a new immutable snapshot");
    const after = (await json("/api/v1/notification-providers")).providers.find((item) => item.id === provider.id);
    assert.equal(after.enabled, false);
    assert.deepEqual(after.events, []);
    checks.push(`${device}: packaged editor, six-event previews, whole-pair fallback, prepare, explicit activation, reload, restore, no subscription changes`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  const migrated = await formatterMigrationDrill({ home, installed, providerId: providerIds[0], json, post });
  providerIds.push(migrated.providerId);
  const recovery = await formatterRecoveryDrill({ home, base, binary, archive, installed, version: health.version, providerIds, json, post,
    stop, restart: async () => { start(); await ready(); } });
  const sha256 = async (filename) => createHash("sha256").update(await fs.readFile(filename)).digest("hex");
  const receipt = { mode: "private-development-host", host_version: health.version,
    host_sha256: await sha256(binary), package_sha256: await sha256(archive), checks, migration: migrated.receipt, recovery };
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(receipt, null, 2));
  }
} catch (error) {
  await fs.writeFile(path.join(output, "failure.log"), logs, { mode: 0o600 });
  try { await fs.copyFile(path.join(home, "logs/backend-logs.log"), path.join(output, "failure-backend.log")); }
  catch { /* Startup failures may precede structured logger creation. */ }
  if (currentPage && !currentPage.isClosed()) {
    try {
      await fs.writeFile(path.join(output, "failure.html"), await currentPage.content(), { mode: 0o600 });
      await fs.writeFile(path.join(output, "failure-ui.txt"), `${String(error)}\n${browserErrors.join("\n")}\n${await currentPage.locator("body").innerText()}`, { mode: 0o600 });
      await currentPage.screenshot({ path: path.join(output, "failure.png"), fullPage: true, timeout: 5000 });
    } catch { /* Diagnostic capture must not replace the original failure. */ }
  }
  throw error;
} finally {
  await browser?.close();
  await stop();
  await fs.rm(home, { recursive: true, force: true });
}
