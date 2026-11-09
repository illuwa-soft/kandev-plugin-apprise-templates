const emptyConfiguration = () => ({ version: 1, origin: "", templates: {} });

function ownsBinding(options, binding) {
  return binding?.plugin_id === options.formatter.plugin_id &&
    binding?.installation_id === options.formatter.installation_id &&
    binding?.formatter_key === options.formatter.key;
}

export function createEditorController(options) {
  let stopped = false;
  let previewGeneration = 0;
  let previewAbort;
  let lifecycle = new AbortController();
  let loadGeneration = 0;
  let pendingLoadEdits = new Map();
  let pendingImportEdits = null;
  let writeGeneration = 0;
  let snapshotGeneration = 0;
  let uncertainActivation = null;
  let baseline = JSON.stringify(emptyConfiguration());
  let prepared = null;
  let observedBinding = options.binding;
  const listeners = new Set();
  let state = {
    configuration: emptyConfiguration(), events: [], variables: {}, event: "session.clarification_requested",
    sample: "normal", loaded: false, saving: false, preview: null, notice: "loading",
    active: ownsBinding(options, observedBinding), bindingRevision: observedBinding?.revision ?? "",
    appliedRevision: ownsBinding(options, observedBinding) ? observedBinding.configuration_revision : "",
  };
  function publish(patch) {
    if (stopped) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }
  const invoke = (key, body) => options.invoke(key, {
    notificationProviderId: options.provider.id,
    notificationFormatter: { installationId: options.formatter.installation_id, formatterKey: options.formatter.key,
      expectedBindingRevision: state.bindingRevision, mode: state.active ? "active" : "candidate" },
    body,
  }, { signal: lifecycle.signal });
  function ensureLive(signal) {
    if (signal.aborted || signal !== lifecycle.signal) throw Object.assign(new Error("editor operation cancelled"), { name: "AbortError" });
  }
  const dirty = () => JSON.stringify(state.configuration) !== baseline || (!state.active && !prepared) ||
    (state.active && Boolean(prepared && prepared.snapshot.revision !== state.appliedRevision));
  function editConfiguration(key, update) {
    previewGeneration++;
    previewAbort?.abort();
    for (const edits of [!state.loaded ? pendingLoadEdits : null, pendingImportEdits]) {
      if (!edits) continue;
      edits.delete(key);
      edits.set(key, update);
    }
    publish({ preview: null, configuration: update(state.configuration) });
  }
  function catalogState(catalog) {
    const event = catalog.events.includes(state.event) ? state.event : catalog.events[0];
    return { events: catalog.events, variables: catalog.variables, event, loaded: true };
  }
  const mergeEdits = (configuration, edits) => [...edits.values()].reduce(
    (current, update) => update(current), structuredClone(configuration),
  );
  function adopt(snapshot, catalog, edits) {
    const candidate = snapshot.latest_prepared ?? snapshot;
    baseline = JSON.stringify(candidate.configuration);
    prepared = candidate.revision ? { snapshot: candidate, raw: baseline } : null;
    const configuration = mergeEdits(candidate.configuration, edits);
    pendingLoadEdits = new Map();
    publish({ ...catalogState(catalog), configuration,
      notice: candidate.revision && candidate.revision !== state.appliedRevision ? "prepared" : (state.active ? "active" : "ready") });
  }
  function applied(binding, submitted) {
    observedBinding = binding;
    publish({ active: true, bindingRevision: binding.revision, appliedRevision: binding.configuration_revision,
      notice: "active", saving: false });
    if (prepared === submitted) prepared = null;
  }
  async function reconcile(signal) {
    const pending = uncertainActivation;
    const actual = await options.readActiveBinding();
    ensureLive(signal);
    uncertainActivation = null;
    if (ownsBinding(options, actual) && actual.configuration_revision === pending.snapshot.revision) {
      applied(actual, pending);
      return pending;
    }
    return null;
  }
  async function activate(submitted) {
    const signal = lifecycle.signal;
    ensureLive(signal);
    if (uncertainActivation) {
      const confirmed = await reconcile(signal);
      if (confirmed?.snapshot.revision === submitted.snapshot.revision) return;
    }
    try {
      const binding = await options.activateConfiguration(submitted.snapshot, state.bindingRevision);
      ensureLive(signal);
      applied(binding, submitted);
    } catch (error) {
      ensureLive(signal);
      uncertainActivation = submitted;
      try {
        if (await reconcile(signal)) return;
      } catch { /* A failed readback cannot establish the activation outcome. */ }
      ensureLive(signal);
      publish({ notice: "savedNotApplied", saving: false });
      throw error;
    }
  }
  const controller = {
    get state() { return state; },
    isDirty: dirty,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    start() {
      if (!stopped) return;
      stopped = false;
      lifecycle = new AbortController();
    },
    async load() {
      const generation = ++loadGeneration;
      const snapshotAtStart = snapshotGeneration;
      const edits = state.loaded ? new Map() : pendingLoadEdits;
      pendingLoadEdits = edits;
      publish({ loaded: false, notice: "loading" });
      try {
        const revision = ownsBinding(options, observedBinding) ? observedBinding.configuration_revision : "";
        const [snapshot, catalog] = await Promise.all([
          invoke("templates.get", { revision }), invoke("templates.catalog", {}),
        ]);
        if (generation === loadGeneration) {
          if (snapshotAtStart === snapshotGeneration) adopt(snapshot, catalog, edits);
          else publish(catalogState(catalog));
        }
      } catch {
        if (generation === loadGeneration) publish({ notice: "loadError", loaded: false });
      }
    },
    editTemplate(field, value) {
      const event = state.event;
      editConfiguration(`${event}:${field}`, (configuration) => {
        const previous = configuration.templates[event] ?? { version: 1, title: "{{default.title}}", body: "{{default.body}}" };
        return { ...configuration, templates: { ...configuration.templates, [event]: { ...previous, [field]: value } } };
      });
    },
    editOrigin(origin) {
      editConfiguration("origin", (configuration) => ({ ...configuration, origin }));
    },
    selectEvent(event) {
      previewGeneration++; previewAbort?.abort();
      publish({ event, sample: "normal", preview: null });
    },
    selectSample(sample) {
      previewGeneration++; previewAbort?.abort();
      publish({ sample, preview: null });
    },
    restore() {
      const event = state.event;
      editConfiguration(`${event}:restore`, (configuration) => {
        const templates = { ...configuration.templates };
        delete templates[event];
        const source_revisions = { ...configuration.source_revisions };
        delete source_revisions[event];
        return { ...configuration, templates, source_revisions };
      });
    },
    discard() { pendingLoadEdits.clear(); pendingImportEdits?.clear(); previewGeneration++; previewAbort?.abort(); publish({ configuration: JSON.parse(baseline), preview: null }); },
    async preview() {
      previewAbort?.abort();
      const generation = ++previewGeneration;
      previewAbort = new AbortController();
      try {
        const result = await options.previewConfiguration(state.configuration, state.event, state.sample, previewAbort.signal);
        if (generation === previewGeneration) publish({ preview: result });
      } catch {
        if (generation === previewGeneration && !previewAbort.signal.aborted) publish({ notice: "previewError" });
      }
    },
    async save() {
      if (!state.loaded || state.saving) throw new Error("template editor is not ready");
      writeGeneration++;
      const signal = lifecycle.signal;
      publish({ saving: true });
      const configuration = structuredClone(state.configuration);
      const raw = JSON.stringify(configuration);
      try {
        if (!prepared || prepared.raw !== raw) {
          const snapshot = await invoke("templates.prepare", { configuration });
          ensureLive(signal);
          prepared = { snapshot, raw };
        }
        baseline = raw;
        if (state.active) await activate(prepared);
        else publish({ notice: "prepared", saving: false });
      } catch (error) {
        if (signal === lifecycle.signal && !signal.aborted) publish({ saving: false, notice: prepared?.raw === raw ? "savedNotApplied" : "saveError" });
        throw error;
      }
    },
    async activatePrepared() {
      if (!prepared || state.saving) return;
      writeGeneration++;
      const signal = lifecycle.signal;
      publish({ saving: true });
      try { await activate(prepared); }
      catch (error) {
        if (signal === lifecycle.signal && !signal.aborted) publish({ saving: false, notice: "savedNotApplied" });
        throw error;
      }
    },
    hasPrepared() { return Boolean(prepared && prepared.snapshot.revision !== state.appliedRevision); },
    async importConfiguration(document) {
      if (state.saving) throw new Error("template save is in progress");
      const operation = ++writeGeneration;
      const signal = lifecycle.signal;
      const edits = new Map();
      pendingImportEdits = edits;
      previewGeneration++; previewAbort?.abort();
      try {
        const snapshot = await invoke("templates.import", document);
        ensureLive(signal);
        if (operation !== writeGeneration) return;
        snapshotGeneration++;
        pendingLoadEdits = new Map();
        baseline = JSON.stringify(snapshot.configuration);
        prepared = { snapshot, raw: baseline };
        publish({ configuration: mergeEdits(snapshot.configuration, edits), notice: "prepared" });
      } finally {
        if (pendingImportEdits === edits) pendingImportEdits = null;
      }
    },
    async reload() {
      writeGeneration++;
      loadGeneration++;
      const signal = lifecycle.signal;
      pendingLoadEdits = new Map();
      publish({ loaded: false, notice: "loading" });
      observedBinding = await options.readActiveBinding();
      ensureLive(signal);
      publish({ active: ownsBinding(options, observedBinding), bindingRevision: observedBinding?.revision ?? "",
        appliedRevision: ownsBinding(options, observedBinding) ? observedBinding.configuration_revision : "", loaded: false });
      await controller.load();
    },
    exportConfiguration() { return invoke("templates.export", { revision: prepared?.snapshot.revision ?? state.appliedRevision }); },
    reportError(notice) { publish({ notice }); },
    destroy() { stopped = true; lifecycle.abort(); loadGeneration++; previewGeneration++; previewAbort?.abort(); listeners.clear(); },
  };
  return controller;
}
