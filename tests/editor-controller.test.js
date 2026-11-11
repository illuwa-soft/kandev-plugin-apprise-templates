import assert from "node:assert/strict";
import test from "node:test";

const { createEditorController } = await import("../ui/editor-controller.js");
const config = () => ({ version: 1, origin: "", templates: {} });
const binding = { plugin_id: "kandev-plugin-apprise-templates", installation_id: "install", formatter_key: "apprise-text", configuration_revision: "old", revision: "binding-old" };

function fixture(overrides = {}) {
  return {
    provider: { id: "mail", name: "Mail", type: "apprise", events: [] },
    formatter: { plugin_id: binding.plugin_id, installation_id: "install", key: "apprise-text" },
    binding,
    invoke: async (key, input) => {
      assert.equal(input.notificationProviderId, "mail");
      if (key === "templates.catalog") return { events: ["session.failed"], variables: { "session.failed": ["task.title"] } };
      if (key === "templates.get") return { revision: "old", digest: "old-digest", configuration: config() };
      return { revision: "prepared", digest: "new-digest", configuration: input.body.configuration };
    },
    activateConfiguration: async () => ({ ...binding, configuration_revision: "prepared", revision: "binding-new" }),
    previewConfiguration: async () => ({ title: "Preview", body: "Body", used_fallback: false }),
    readActiveBinding: async () => binding,
    ...overrides,
  };
}

test("Save applies the submitted snapshot and preserves later edits", async () => {
  let complete;
  const activation = new Promise((resolve) => { complete = resolve; });
  const editor = createEditorController(fixture({ activateConfiguration: () => activation }));
  await editor.load();
  editor.editTemplate("title", "Submitted title");
  const save = editor.save();
  await new Promise((resolve) => queueMicrotask(resolve));
  editor.editTemplate("title", "Later edit");
  complete({ ...binding, configuration_revision: "prepared", revision: "binding-new" });
  await save;
  assert.equal(editor.state.configuration.templates["session.failed"].title, "Later edit");
  assert.equal(editor.isDirty(), true);
  assert.equal(editor.state.bindingRevision, "binding-new");
  editor.destroy();
});

test("an uncertain activation is reconciled without resending it", async () => {
  let activations = 0;
  const editor = createEditorController(fixture({
    activateConfiguration: async () => { activations++; throw new Error("lost response"); },
    readActiveBinding: async () => ({ ...binding, configuration_revision: "prepared", revision: "binding-new" }),
  }));
  await editor.load();
  editor.editTemplate("title", "Submitted title");
  await editor.save();
  assert.equal(activations, 1);
  assert.equal(editor.isDirty(), false);
  assert.equal(editor.state.bindingRevision, "binding-new");
  editor.destroy();
});

test("saved-but-not-applied remains retryable through shared Save", async () => {
  let attempts = 0;
  let preparations = 0;
  const options = fixture({
    activateConfiguration: async () => {
      if (++attempts === 1) throw new Error("activation conflict");
      return { ...binding, configuration_revision: "prepared", revision: "binding-new" };
    },
  });
  const invoke = options.invoke;
  options.invoke = (key, input) => {
    if (key === "templates.prepare") preparations++;
    return invoke(key, input);
  };
  const editor = createEditorController(options);
  await editor.load();
  editor.editTemplate("title", "Retained snapshot");
  await assert.rejects(editor.save(), /activation conflict/);
  assert.equal(editor.state.notice, "savedNotApplied");
  assert.equal(editor.isDirty(), true);
  await editor.save();
  assert.equal(preparations, 1);
  assert.equal(editor.isDirty(), false);
  editor.destroy();
});

test("effect setup-cleanup-setup uses a fresh signal and rejects a stale load", async () => {
  let releaseOld;
  let gets = 0;
  const signals = [];
  const options = fixture();
  const invoke = options.invoke;
  options.invoke = (key, input, transport) => {
    signals.push(transport.signal);
    if (key === "templates.get" && ++gets === 1) {
      return new Promise((resolve) => { releaseOld = resolve; });
    }
    return invoke(key, input);
  };
  const editor = createEditorController(options);
  const oldLoad = editor.load();
  editor.destroy();
  assert.equal(signals[0].aborted, true);
  editor.start();
  await editor.load();
  assert.equal(signals.at(-1).aborted, false);
  assert.equal(editor.state.loaded, true);
  releaseOld({ revision: "stale", configuration: { ...config(), origin: "https://stale.invalid" } });
  await oldLoad;
  assert.equal(editor.state.configuration.origin, "");
  editor.destroy();
});

test("failed readback blocks resending an uncertain activation", async () => {
  let activations = 0;
  let readable = false;
  const editor = createEditorController(fixture({
    activateConfiguration: async () => { activations++; throw new Error("lost response"); },
    readActiveBinding: async () => {
      if (!readable) throw new Error("readback unavailable");
      return { ...binding, configuration_revision: "prepared", revision: "binding-new" };
    },
  }));
  await editor.load();
  editor.editTemplate("title", "Uncertain save");
  await assert.rejects(editor.save());
  await assert.rejects(editor.activatePrepared());
  assert.equal(activations, 1);
  assert.equal(editor.state.saving, false);
  readable = true;
  await editor.save();
  assert.equal(activations, 1);
  assert.equal(editor.isDirty(), false);
  editor.destroy();
});

test("destroy during prepare prevents a later activation", async () => {
  let finish;
  let activations = 0;
  const options = fixture({ activateConfiguration: async () => { activations++; return binding; } });
  const invoke = options.invoke;
  options.invoke = (key, input) => key === "templates.prepare"
    ? new Promise((resolve) => { finish = () => resolve({ revision: "prepared", configuration: input.body.configuration }); })
    : invoke(key, input);
  const editor = createEditorController(options);
  await editor.load();
  editor.editTemplate("title", "Submitted");
  const saving = editor.save();
  editor.destroy();
  finish();
  await assert.rejects(saving, { name: "AbortError" });
  assert.equal(activations, 0);
});

test("an import completion preserves a newer draft", async () => {
  let finish;
  const options = fixture();
  const invoke = options.invoke;
  options.invoke = (key, input) => key === "templates.import"
    ? new Promise((resolve) => { finish = resolve; }) : invoke(key, input);
  const editor = createEditorController(options);
  await editor.load();
  const importing = editor.importConfiguration({});
  editor.editTemplate("title", "Later edit");
  finish({ revision: "imported", configuration: { ...config(), origin: "https://imported.invalid" } });
  await importing;
  assert.equal(editor.state.configuration.templates["session.failed"].title, "Later edit");
  assert.equal(editor.isDirty(), true);
  editor.destroy();
});

test("a late import cannot replace the activation target from a newer Save", async () => {
  let finishImport;
  let activated;
  const options = fixture({ binding: null, activateConfiguration: async (snapshot) => {
    activated = snapshot.revision;
    return { ...binding, configuration_revision: snapshot.revision };
  } });
  const invoke = options.invoke;
  options.invoke = (key, input) => {
    if (key === "templates.import") return new Promise((resolve) => { finishImport = resolve; });
    return invoke(key, input);
  };
  const editor = createEditorController(options);
  await editor.load();
  const importing = editor.importConfiguration({});
  editor.editOrigin("https://newer.invalid");
  await editor.save();
  finishImport({ revision: "older-import", configuration: { ...config(), origin: "https://older.invalid" } });
  await importing;
  await editor.activatePrepared();
  assert.equal(activated, "prepared");
  assert.equal(editor.state.configuration.origin, "https://newer.invalid");
  editor.destroy();
});

test("a delayed load merges newer field edits without dropping saved templates", async () => {
  let finish;
  const options = fixture();
  const invoke = options.invoke;
  options.invoke = (key, input) => key === "templates.get"
    ? new Promise((resolve) => { finish = resolve; }) : invoke(key, input);
  const editor = createEditorController(options);
  const loading = editor.load();
  editor.editOrigin("https://draft.invalid");
  editor.editTemplate("title", "Later title");
  finish({ revision: "old", configuration: { version: 1, origin: "https://saved.invalid", templates: {
    "session.clarification_requested": { version: 1, title: "Saved title", body: "Saved body" },
    "session.failed": { version: 1, title: "Failure title", body: "Failure body" },
  } } });
  await loading;
  assert.equal(editor.state.loaded, true);
  assert.equal(editor.state.configuration.origin, "https://draft.invalid");
  assert.deepEqual(editor.state.configuration.templates["session.clarification_requested"], {
    version: 1, title: "Later title", body: "Saved body",
  });
  assert.equal(editor.state.configuration.templates["session.failed"].body, "Failure body");
  assert.equal(editor.isDirty(), true);
  editor.discard();
  assert.equal(editor.state.configuration.origin, "https://saved.invalid");
  assert.equal(editor.state.configuration.templates["session.clarification_requested"].title, "Saved title");
  assert.equal(editor.isDirty(), false);
  editor.destroy();
});

test("load retry retains edits made after a loading failure", async () => {
  const options = fixture();
  const invoke = options.invoke;
  let available = false;
  options.invoke = (key, input) => {
    if (!available) throw new Error("unavailable");
    return invoke(key, input);
  };
  const editor = createEditorController(options);
  await editor.load();
  editor.editOrigin("https://retained.invalid");
  available = true;
  await editor.load();
  assert.equal(editor.state.loaded, true);
  assert.equal(editor.state.configuration.origin, "https://retained.invalid");
  assert.equal(editor.isDirty(), true);
  editor.destroy();
});

test("Reset during loading discards queued edits before the saved snapshot arrives", async () => {
  let finish;
  const options = fixture();
  const invoke = options.invoke;
  options.invoke = (key, input) => key === "templates.get"
    ? new Promise((resolve) => { finish = resolve; }) : invoke(key, input);
  const editor = createEditorController(options);
  const loading = editor.load();
  editor.editOrigin("https://discarded.invalid");
  editor.discard();
  finish({ revision: "old", configuration: { ...config(), origin: "https://saved.invalid" } });
  await loading;
  assert.equal(editor.state.configuration.origin, "https://saved.invalid");
  assert.equal(editor.isDirty(), false);
  editor.destroy();
});

test("reload preserves edits made while reading the authoritative binding", async () => {
  let finish;
  const editor = createEditorController(fixture({ readActiveBinding: () => new Promise((resolve) => { finish = resolve; }) }));
  await editor.load();
  const loading = editor.reload();
  editor.editOrigin("https://during-readback.invalid");
  finish(binding);
  await loading;
  assert.equal(editor.state.configuration.origin, "https://during-readback.invalid");
  assert.equal(editor.isDirty(), true);
  editor.destroy();
});

test("a load started before import cannot replace its prepared snapshot", async () => {
  let finish, activated;
  const options = fixture({ activateConfiguration: async (snapshot) => {
    activated = snapshot.revision;
    return { ...binding, configuration_revision: snapshot.revision };
  } });
  const invoke = options.invoke;
  options.invoke = (key, input) => {
    if (key === "templates.get") return new Promise((resolve) => { finish = resolve; });
    if (key === "templates.import") return { revision: "imported", configuration: {
      ...config(), origin: "https://imported.invalid",
    } };
    return invoke(key, input);
  };
  const editor = createEditorController(options);
  const loading = editor.load();
  await editor.importConfiguration({});
  finish({ revision: "old", configuration: config() });
  await loading;
  assert.equal(editor.state.loaded, true);
  assert.deepEqual(editor.state.events, ["session.failed"]);
  assert.equal(editor.state.configuration.origin, "https://imported.invalid");
  assert.equal(editor.isDirty(), true);
  await editor.activatePrepared();
  assert.equal(activated, "imported");
  assert.equal(editor.isDirty(), false);
  editor.destroy();
});

test("edits during import merge over imported templates before the next Save", async () => {
  let finishLoad, finishImport, submitted;
  const options = fixture({ binding: null });
  const invoke = options.invoke;
  options.invoke = (key, input) => {
    if (key === "templates.get") return new Promise((resolve) => { finishLoad = resolve; });
    if (key === "templates.import") return new Promise((resolve) => { finishImport = resolve; });
    if (key === "templates.prepare") submitted = input.body.configuration;
    return invoke(key, input);
  };
  const editor = createEditorController(options);
  const loading = editor.load();
  const importing = editor.importConfiguration({});
  editor.editOrigin("https://later.invalid");
  const templates = {
    "session.failed": { version: 1, title: "Failure", body: "Imported failure" },
    "office.inbox_item": { version: 1, title: "Inbox", body: "Imported inbox" },
  };
  finishImport({ revision: "imported", configuration: { ...config(), templates } });
  await importing;
  finishLoad({ revision: "old", configuration: config() });
  await loading;
  await editor.save();
  assert.equal(submitted.origin, "https://later.invalid");
  assert.deepEqual(submitted.templates, templates);
  editor.destroy();
});
