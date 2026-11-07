package main

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPreparedSnapshotsAreImmutableAndOwnerScoped(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	store, err := OpenSnapshotStore(dir)
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	config := TemplateConfiguration{Version: 1, Origin: "https://example.invalid", Templates: map[string]EventTemplate{
		"session.failed": {Version: 1, Title: "Failed: {{task.title}}", Body: "{{session.url}}"},
	}}
	first, err := store.Prepare(ctx, "alice", "mail", config)
	require.NoError(t, err)
	config.Templates["session.failed"] = EventTemplate{Version: 1, Title: "Changed", Body: "Changed body"}
	second, err := store.Prepare(ctx, "alice", "mail", config)
	require.NoError(t, err)
	require.NotEqual(t, first.Revision, second.Revision)
	original, err := store.Read(ctx, "alice", "mail", first.Revision)
	require.NoError(t, err)
	require.Equal(t, "Failed: {{task.title}}", original.Configuration.Templates["session.failed"].Title)
	_, err = store.Read(ctx, "bob", "mail", first.Revision)
	require.ErrorIs(t, err, ErrSnapshotNotFound)
	require.NoError(t, store.Close())
	store, err = OpenSnapshotStore(dir)
	require.NoError(t, err)
	original, err = store.Read(ctx, "alice", "mail", first.Revision)
	require.NoError(t, err)
	require.Equal(t, first.Digest, original.Digest)
}

func TestLegacyImportIsRepeatableButNeverOverwritesAnotherConfiguration(t *testing.T) {
	store, err := OpenSnapshotStore(t.TempDir())
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	configuration := TemplateConfiguration{Version: 1, Templates: map[string]EventTemplate{
		"session.turn_finished": {Version: 1, Title: "Custom", Body: "Body"},
	}}
	first, err := store.Import(context.Background(), "alice", "mail", strings.Repeat("a", 64), configuration)
	require.NoError(t, err)
	second, err := store.Import(context.Background(), "alice", "mail", strings.Repeat("a", 64), configuration)
	require.NoError(t, err)
	require.Equal(t, first.Revision, second.Revision)
	_, err = store.Import(context.Background(), "alice", "mail", strings.Repeat("b", 64), configuration)
	require.ErrorIs(t, err, ErrImportConflict)
	configuration.Templates["session.turn_finished"] = EventTemplate{Version: 1, Title: "Changed", Body: "Body"}
	_, err = store.Import(context.Background(), "alice", "mail", strings.Repeat("a", 64), configuration)
	require.ErrorIs(t, err, ErrImportConflict)
	_, err = store.Prepare(context.Background(), "alice", "mail", configuration)
	require.NoError(t, err)
	configuration.Templates["session.turn_finished"] = first.Configuration.Templates["session.turn_finished"]
	_, err = store.Import(context.Background(), "alice", "mail", strings.Repeat("a", 64), configuration)
	require.ErrorIs(t, err, ErrImportConflict)
}
