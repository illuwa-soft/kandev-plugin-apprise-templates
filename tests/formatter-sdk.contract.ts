// Compile against the selected SDK, never a locally declared substitute.
import type {
  ActionInput,
  NotificationFormatterActionContext,
  NotificationFormatterBinding,
  NotificationFormatterChoice,
  NotificationFormatterSlotProps,
  PluginHostApi,
} from "@kdlbs/plugin-sdk";

// These are the fields consumed by ui/editor-controller.js and ui/bundle.js.
export async function formatterEditorContract(
  props: NotificationFormatterSlotProps,
  invoke: PluginHostApi["api"]["invokeAction"],
  signal: AbortSignal,
) {
  const choice: NotificationFormatterChoice = props.formatter;
  const active: NotificationFormatterBinding | null = await props.readActiveBinding();
  const context: NotificationFormatterActionContext = {
    installationId: choice.installation_id,
    formatterKey: choice.key,
    expectedBindingRevision: active?.revision ?? "",
    mode: active?.plugin_id === choice.plugin_id ? "active" : "candidate",
  };
  const input: ActionInput = {
    notificationProviderId: props.provider.id,
    notificationFormatter: context,
    body: { configuration: { version: 1, origin: "", templates: {} } },
  };
  await invoke("templates.prepare", input, { signal });
  const preview: { title: string; body: string; used_fallback: boolean } =
    await props.previewConfiguration(input.body, props.events[0], "normal", signal);
  const binding: NotificationFormatterBinding = await props.activateConfiguration(
    { revision: "prepared-revision", digest: "0".repeat(64) },
    props.binding?.revision ?? "",
  );
  await props.reload();
  return { preview, binding, selectionChanged: props.selectionChanged };
}
