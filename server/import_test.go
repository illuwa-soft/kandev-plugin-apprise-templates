package main

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestImportReceiptFailureRollsBackThePreparedSnapshot(t *testing.T) {
	store, err := OpenSnapshotStore(t.TempDir())
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	_, err = store.db.Exec(`CREATE TRIGGER interrupt_import BEFORE INSERT ON imports BEGIN SELECT RAISE(ABORT,'fixture interruption'); END`)
	require.NoError(t, err)
	configuration := TemplateConfiguration{Version: 1, Templates: map[string]EventTemplate{"session.turn_finished": {Version: 1, Title: "Literal title", Body: "Literal body"}}}
	_, err = store.Import(context.Background(), "alice", "mail", strings.Repeat("a", 64), configuration)
	require.Error(t, err)
	_, err = store.Latest(context.Background(), "alice", "mail")
	require.ErrorIs(t, err, ErrSnapshotNotFound)
	_, err = store.db.Exec(`DROP TRIGGER interrupt_import`)
	require.NoError(t, err)
	prepared, err := store.Import(context.Background(), "alice", "mail", strings.Repeat("a", 64), configuration)
	require.NoError(t, err)
	require.Equal(t, configuration, prepared.Configuration)
}
