import { createEditorController } from "./ui/ui/editor-controller.js?v=0.1.0";
import { messages } from "./ui/ui/translations.js?v=0.1.0";

function sampleKeys(event) {
  if (event === "system.update_available") return ["normal", "runtime_available", "runtime_succeeded", "runtime_failed", "runtime_interrupted", "runtime_summary", "missing_url"];
  if (event === "office.inbox_item") return ["normal", "missing_url"];
  return ["normal", "missing_title", "missing_session", "missing_url"];
}

function downloadConfiguration(document) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2)], { type: "application/json" }));
  const anchor = window.document.createElement("a");
  anchor.href = url; anchor.download = "apprise-templates.json";
  anchor.click(); URL.revokeObjectURL(url);
}

function createEditor(host) {
  const React = host.React;
  const h = host.jsx;
  const { Button, Input, Textarea } = host.ui;
  return function TemplateEditor({ slotProps: props }) {
    const { t } = host.i18n.useTranslation();
    const controllerRef = React.useRef(null);
    if (!controllerRef.current) controllerRef.current = createEditorController({
      ...props, invoke: (key, input, options) => host.api.invokeAction(key, input, options),
    });
    const editor = controllerRef.current;
    const [state, setState] = React.useState(editor.state);
    React.useEffect(() => {
      editor.start();
      const unsubscribe = editor.subscribe(setState);
      void editor.load();
      return () => { unsubscribe(); editor.destroy(); };
    }, [editor]);
    host.useSettingsSaveContributor({
      id: `templates:${props.provider.id}`, order: 40,
      revision: JSON.stringify([state.configuration, state.bindingRevision]),
      isDirty: editor.isDirty(), canSave: state.loaded && !state.saving,
      save: () => editor.save(), discard: () => editor.discard(),
    });
    const run = (promise, notice) => { void promise.catch(() => editor.reportError(notice)); };
    const template = state.configuration.templates[state.event];
    const id = `apprise-${props.provider.id}`;
    const label = (key, control) => h("label", { className: "block space-y-1 text-sm" }, h("span", {}, t(key)), control);
    const inputClass = "min-h-7 w-full [@media(pointer:coarse)]:min-h-11";
    const button = (key, onClick, disabled = false) => h(Button, { type: "button", variant: "outline", className: "cursor-pointer [@media(pointer:coarse)]:min-h-11", onClick, disabled }, t(key));
    return h("div", { className: "min-w-0 space-y-4", "data-testid": "apprise-template-editor" },
      h("h4", { className: "font-medium" }, t("heading")),
      h("p", { role: "status", className: "text-sm text-muted-foreground", "data-testid": "apprise-template-status" }, t(state.notice)),
      label("origin", h(Input, { className: inputClass, value: state.configuration.origin, onChange: (event) => editor.editOrigin(event.target.value), "data-testid": "apprise-template-origin" })),
      label("event", h("select", { className: `${inputClass} cursor-pointer rounded-md border bg-background px-2`, value: state.event, onChange: (event) => editor.selectEvent(event.target.value), disabled: !state.loaded, "data-testid": "apprise-template-event" },
        ...state.events.map((event) => h("option", { key: event, value: event }, event)))),
      h("p", { className: "text-sm" }, t(props.provider.events.includes(state.event) ? "subscribed" : "unsubscribed"), " / ", t(template ? "custom" : "default")),
      label("title", h(Input, { id: `${id}-title`, className: inputClass, value: template?.title ?? "{{default.title}}", onChange: (event) => editor.editTemplate("title", event.target.value), "data-testid": "apprise-template-title" })),
      label("body", h(Textarea, { id: `${id}-body`, rows: 6, className: "min-h-28 w-full", value: template?.body ?? "{{default.body}}", onChange: (event) => editor.editTemplate("body", event.target.value), "data-testid": "apprise-template-body" })),
      h("p", { className: "text-sm text-muted-foreground" }, t("help")),
      h("div", { className: "space-y-2" }, h("p", { className: "text-sm" }, t("variables")),
        h("div", { className: "flex flex-wrap gap-2" }, ...(state.variables[state.event] ?? []).map((variable) => h(Button, {
          type: "button", variant: "outline", size: "sm", key: variable, className: "cursor-pointer [@media(pointer:coarse)]:min-h-11",
          onClick: () => editor.editTemplate("body", `${template?.body ?? "{{default.body}}"} {{${variable}}}`),
        }, h("code", {}, variable))))),
      label("sample", h("select", { className: `${inputClass} cursor-pointer rounded-md border bg-background px-2`, value: state.sample, onChange: (event) => editor.selectSample(event.target.value), "data-testid": "apprise-template-sample" },
        ...sampleKeys(state.event).map((sample) => h("option", { key: sample, value: sample }, sample)))),
      h("div", { className: "flex flex-wrap gap-2" },
        button("previewButton", () => run(editor.preview(), "previewError"), !state.loaded),
        button("restore", () => editor.restore(), !state.loaded),
        editor.hasPrepared() ? button("activate", () => run(editor.activatePrepared(), "savedNotApplied"), state.saving) : null),
      state.preview ? h("section", { className: "space-y-2 rounded-md border p-3", "aria-label": t("previewTitle"), "data-testid": "apprise-template-preview" },
        h("h5", { className: "font-medium" }, t("previewTitle")),
        state.preview.used_fallback ? h("p", { role: "status" }, t("fallback")) : null,
        h("pre", { className: "whitespace-pre-wrap break-words text-sm" }, `${state.preview.title}\n\n${state.preview.body}`)) : null,
      label("import", h("input", { type: "file", accept: ".json,application/json", disabled: state.saving, className: inputClass, "data-testid": "apprise-template-import", onChange: (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (file.size > 128 * 1024) { editor.reportError("importError"); return; }
        run(file.text().then((text) => editor.importConfiguration(JSON.parse(text))), "importError");
        event.target.value = "";
      } })),
      h("div", { className: "flex flex-wrap gap-2" },
        button("export", () => run(Promise.resolve(editor.exportConfiguration()).then(downloadConfiguration), "saveError"), !state.loaded),
        button("reload", () => run(editor.reload(), "loadError"), state.saving)),
    );
  };
}

window.registerKandevPlugin("kandev-plugin-apprise-templates", {
  initialize(registry, host) {
    registry.registerTranslations(messages);
    registry.registerComponent("notification-formatter", createEditor(host));
  },
  destroy() {},
});
