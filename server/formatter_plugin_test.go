package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kdlbs/kandev/pluginsdk"
	"github.com/stretchr/testify/require"
)

func TestPluginPreparesWithoutActivationAndFormatsRequestedSnapshot(t *testing.T) {
	store, err := OpenSnapshotStore(t.TempDir())
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	plugin := &formatterPlugin{store: store}
	config := TemplateConfiguration{Version: 1, Origin: "https://example.invalid", Templates: map[string]EventTemplate{}}
	for _, event := range templateEvents {
		config.Templates[event] = EventTemplate{Version: 1, Title: "{{event.type}}", Body: "{{default.body}}"}
	}
	raw, err := json.Marshal(map[string]any{"configuration": config})
	require.NoError(t, err)
	response, err := plugin.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: "templates.prepare", Context: pluginsdk.VerifiedActionContext{ActorID: "alice", NotificationProviderID: "mail"}, Body: raw,
	})
	require.NoError(t, err)
	require.Equal(t, 200, response.Status)
	var snapshot PreparedSnapshot
	require.NoError(t, json.Unmarshal(response.Body, &snapshot))
	for _, event := range templateEvents {
		result, err := plugin.FormatNotification(context.Background(), &pluginsdk.NotificationFormatRequest{
			ContractVersion: 1, OwnerId: "alice", ProviderId: "mail", FormatterKey: "apprise-text", ConfigurationRevision: snapshot.Revision,
			EventType: event, DefaultTitle: "Original", DefaultBody: "Literal {{unchanged}}",
		})
		require.NoError(t, err)
		require.True(t, result.Custom)
		require.Equal(t, event, result.Title)
		require.Equal(t, "Literal {{unchanged}}", result.Body)
	}
	_, err = plugin.FormatNotification(context.Background(), &pluginsdk.NotificationFormatRequest{ContractVersion: 1, OwnerId: "bob", ProviderId: "mail", FormatterKey: "apprise-text", ConfigurationRevision: snapshot.Revision})
	require.Error(t, err)
}

func TestConfigurationExportKeepsOwnerAndProviderProvenance(t *testing.T) {
	store, err := OpenSnapshotStore(t.TempDir())
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	prepared, err := store.Prepare(context.Background(), "alice", "mail", TemplateConfiguration{Version: 1, Templates: map[string]EventTemplate{}})
	require.NoError(t, err)
	plugin := &formatterPlugin{store: store}
	request := &pluginsdk.PluginActionRequest{ActionKey: "templates.export", Context: pluginsdk.VerifiedActionContext{ActorID: "alice", NotificationProviderID: "mail"}, Body: []byte(`{"revision":"` + prepared.Revision + `"}`)}
	response, err := plugin.HandleAction(context.Background(), request)
	require.NoError(t, err)
	require.Equal(t, 200, response.Status)
	var exported map[string]any
	require.NoError(t, json.Unmarshal(response.Body, &exported))
	require.Equal(t, "alice", exported["source_owner_id"])
	require.Equal(t, "mail", exported["source_provider_id"])
	exported["source_owner_id"] = "bob"
	request.ActionKey = "templates.import"
	request.Body, err = json.Marshal(exported)
	require.NoError(t, err)
	response, err = plugin.HandleAction(context.Background(), request)
	require.NoError(t, err)
	require.Equal(t, 400, response.Status)
}

func TestPreparedButInactiveConfigurationCanBeRecoveredAfterRestart(t *testing.T) {
	store, err := OpenSnapshotStore(t.TempDir())
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	prepared, err := store.Prepare(context.Background(), "alice", "mail", TemplateConfiguration{Version: 1, Templates: map[string]EventTemplate{"session.failed": {Version: 1, Title: "Saved", Body: "Not applied"}}})
	require.NoError(t, err)
	plugin := &formatterPlugin{store: store}
	response, err := plugin.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{ActionKey: "templates.get", Context: pluginsdk.VerifiedActionContext{ActorID: "alice", NotificationProviderID: "mail"}, Body: []byte(`{"revision":""}`)})
	require.NoError(t, err)
	var recovered PreparedSnapshot
	require.NoError(t, json.Unmarshal(response.Body, &recovered))
	require.Equal(t, prepared.Revision, recovered.Revision)
}
