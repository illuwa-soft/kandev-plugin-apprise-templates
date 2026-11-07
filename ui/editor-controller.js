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
  let draftGeneration = 0;
  let writeGeneration = 0;
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
  function adopt(snapshot, catalog) {
    const candidate = snapshot.latest_prepared ?? snapshot;
    baseline = JSON.stringify(candidate.configuration);
    prepared = candidate.revision ? { snapshot: candidate, raw: baseline } : null;
    const event = catalog.events.includes(state.event) ? state.event : catalog.events[0];
    publish({ configuration: structuredClone(candidate.configuration), events: catalog.events,
      variables: catalog.variables, event, loaded: true, notice: candidate.revision && candidate.revision !== state.appliedRevision ? "prepared" : (state.active ? "active" : "ready") });
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
      try {
        const revision = ownsBinding(options, observedBinding) ? observedBinding.configuration_revision : "";
        const [snapshot, catalog] = await Promise.all([
          invoke("templates.get", { revision }), invoke("templates.catalog", {}),
        ]);
        if (generation === loadGeneration) adopt(snapshot, catalog);
      } catch {
        if (generation === loadGeneration) publish({ notice: "loadError", loaded: false });
      }
    },
    editTemplate(field, value) {
      draftGeneration++;
      previewGeneration++;
      previewAbort?.abort();
      const previous = state.configuration.templates[state.event] ?? { version: 1, title: "{{default.title}}", body: "{{default.body}}" };
      publish({ preview: null, configuration: { ...state.configuration, templates: {
        ...state.configuration.templates, [state.event]: { ...previous, [field]: value },
      } } });
    },
    editOrigin(origin) {
      draftGeneration++;
      previewGeneration++; previewAbort?.abort();
      publish({ preview: null, configuration: { ...state.configuration, origin } });
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
      draftGeneration++;
      previewGeneration++; previewAbort?.abort();
      const templates = { ...state.configuration.templates };
      delete templates[state.event];
      const source_revisions = { ...state.configuration.source_revisions };
      delete source_revisions[state.event];
      publish({ preview: null, configuration: { ...state.configuration, templates, source_revisions } });
    },
    discard() { draftGeneration++; previewGeneration++; previewAbort?.abort(); publish({ configuration: JSON.parse(baseline), preview: null }); },
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
      const generation = ++draftGeneration;
      previewGeneration++; previewAbort?.abort();
      const snapshot = await invoke("templates.import", document);
      ensureLive(signal);
      if (operation !== writeGeneration) return;
      baseline = JSON.stringify(snapshot.configuration);
      prepared = { snapshot, raw: baseline };
      publish({ ...(generation === draftGeneration ? { configuration: structuredClone(snapshot.configuration) } : {}), notice: "prepared" });
    },
    async reload() {
      writeGeneration++;
      const signal = lifecycle.signal;
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
