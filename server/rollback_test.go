package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kdlbs/kandev/pluginsdk"
	"github.com/stretchr/testify/require"
)

func TestRollbackExportPreservesSixEventsAndProjectsOnlyLegacyFour(t *testing.T) {
	store, err := OpenSnapshotStore(t.TempDir())
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	configuration := TemplateConfiguration{Version: 1, Templates: map[string]EventTemplate{}}
	for _, event := range templateEvents {
		configuration.Templates[event] = EventTemplate{Version: 1, Title: "{{event.type}}", Body: "Literal " + event}
	}
	snapshot, err := store.Prepare(context.Background(), "alice", "mail", configuration)
	require.NoError(t, err)
	plugin := &formatterPlugin{store: store}
	request := &pluginsdk.PluginActionRequest{ActionKey: "templates.export", Context: pluginsdk.VerifiedActionContext{ActorID: "alice", NotificationProviderID: "mail"}, Body: []byte(`{"revision":"` + snapshot.Revision + `","target":"legacy-v1"}`)}
	response, err := plugin.HandleAction(context.Background(), request)
	require.NoError(t, err)
	require.Equal(t, 200, response.Status)
	var result struct {
		Schema  int `json:"schema"`
		Current struct {
			Configuration TemplateConfiguration `json:"configuration"`
		} `json:"current"`
		Legacy struct {
			Configuration TemplateConfiguration `json:"configuration"`
		} `json:"legacy"`
		RetainedAdditionalEvents []string `json:"retained_additional_events"`
	}
	require.NoError(t, json.Unmarshal(response.Body, &result))
	require.Equal(t, 1, result.Schema)
	require.Equal(t, configuration, result.Current.Configuration)
	require.Len(t, result.Legacy.Configuration.Templates, 4)
	require.NotContains(t, result.Legacy.Configuration.Templates, "session.failed")
	require.NotContains(t, result.Legacy.Configuration.Templates, "session.permission_requested")
	require.Equal(t, []string{"session.failed", "session.permission_requested"}, result.RetainedAdditionalEvents)
	request.Context.ActorID = "bob"
	response, err = plugin.HandleAction(context.Background(), request)
	require.NoError(t, err)
	require.Equal(t, 404, response.Status)
}
