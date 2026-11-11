import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("a failed candidate load stays dirty without vetoing independent shared saves", async () => {
  let definition;
  const context = vm.createContext({ AbortController, structuredClone, window: {
    registerKandevPlugin(_id, value) { definition = value; },
  } });
  const entry = new vm.SourceTextModule(await readFile(new URL("../ui/bundle.js", import.meta.url), "utf8"), { context });
  await entry.link(async (specifier) => {
    const name = specifier.split("/").at(-1).split("?")[0];
    return new vm.SourceTextModule(await readFile(new URL(`../ui/${name}`, import.meta.url), "utf8"), { context });
  });
  await entry.evaluate();
  let component, state, setup, contributor;
  const ref = { current: null };
  definition.initialize({ registerTranslations() {}, registerComponent(_slot, value) { component = value; } }, {
    React: {
      useRef: () => ref,
      useState(initial) { state ??= initial; return [state, (value) => { state = value; }]; },
      useEffect(value) { setup = value; },
    },
    jsx: (type, props, ...children) => ({ type, props, children }),
    ui: { Button: "button", Input: "input", Textarea: "textarea" },
    i18n: { useTranslation: () => ({ t: (key) => key }) },
    api: { invokeAction: async () => { throw new Error("unavailable"); } },
    useSettingsSaveContributor(value) { contributor = value; },
  });
  const props = { slotProps: { provider: { id: "mail", events: [] },
    formatter: { plugin_id: "plugin", installation_id: "install", key: "text" }, binding: null } };
  component(props);
  const cleanup = setup();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    component(props);
    assert.equal(state.notice, "loadError");
    assert.equal(contributor.isDirty, true);
    assert.notEqual(contributor.canSave, false, "candidate failure must not veto the whole shared save");
    await assert.rejects(contributor.save(), /not ready/);
  } finally { cleanup(); }
});

test("the product registers only its owned formatter editor and complete locale catalogs", async () => {
  let definition;
  const context = vm.createContext({ window: { registerKandevPlugin(id, value) {
    assert.equal(id, "kandev-plugin-apprise-templates"); definition = value;
  } } });
  const entry = new vm.SourceTextModule(await readFile(new URL("../ui/bundle.js", import.meta.url), "utf8"), {
    context, identifier: "https://example.invalid/api/plugins/kandev-plugin-apprise-templates/bundle?v=0.1.0",
  });
  await entry.link(async (specifier, parent) => {
    const remote = new URL(specifier, parent.identifier);
    assert.match(remote.pathname, /^\/api\/plugins\/kandev-plugin-apprise-templates\/ui\/ui\/(editor-controller|translations)\.js$/);
    assert.equal(remote.searchParams.get("v"), "0.1.0");
    const name = remote.pathname.split("/").at(-1);
    return new vm.SourceTextModule(await readFile(new URL(`../ui/${name}`, import.meta.url), "utf8"), { context, identifier: remote.href });
  });
  await entry.evaluate();
  const slots = [];
  let catalogs;
  definition.initialize({
    registerTranslations(value) { catalogs = value; },
    registerComponent(slot, component) { slots.push([slot, component]); },
  }, { React: {}, ui: {} });
  assert.equal(slots.length, 1);
  assert.equal(slots[0][0], "notification-formatter");
  assert.equal(typeof slots[0][1], "function");
  const keys = Object.keys(catalogs.en).sort();
  for (const locale of ["ko", "ja", "pt-pt", "zh-cn", "zh-tw", "zh-hk"]) {
    assert.deepEqual(Object.keys(catalogs[locale]).sort(), keys, locale);
  }
  definition.destroy();
});
