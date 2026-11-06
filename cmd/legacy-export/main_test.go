package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

func TestOfflineExportPreservesTemplatesAndExcludesProviderConfig(t *testing.T) {
	directory := t.TempDir()
	source := filepath.Join(directory, "snapshot.db")
	db, err := sql.Open("sqlite", source)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	_, err = db.Exec(`CREATE TABLE kandev_meta(key TEXT PRIMARY KEY,value TEXT);
INSERT INTO kandev_meta VALUES('kandev_version','0.98.0+upstream-history.apprise-templates.1');
CREATE TABLE notification_providers(id TEXT PRIMARY KEY,user_id TEXT,type TEXT,config TEXT);
CREATE TABLE notification_templates(provider_id TEXT NOT NULL REFERENCES notification_providers(id) ON DELETE CASCADE,user_id TEXT NOT NULL,event_type TEXT NOT NULL,template_json TEXT NOT NULL,revision TEXT NOT NULL,created_at TIMESTAMP NOT NULL,updated_at TIMESTAMP NOT NULL,PRIMARY KEY(provider_id,event_type));
INSERT INTO notification_providers VALUES('mail','alice','apprise','do-not-export-receiver-config');
INSERT INTO notification_templates VALUES('mail','alice','session.turn_finished','{"version":1,"title":"Subject {{task.title}}","body":"Open {{session.url}}"}','source-revision',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);`)
	require.NoError(t, err)
	require.NoError(t, db.Close())
	before, err := os.ReadFile(source)
	require.NoError(t, err)
	output := filepath.Join(directory, "private-export")
	require.NoError(t, run([]string{"--snapshot", source, "--output", output, "--origin", "https://example.invalid"}))
	files, err := filepath.Glob(filepath.Join(output, "*.json"))
	require.NoError(t, err)
	require.Len(t, files, 1)
	content, err := os.ReadFile(files[0])
	require.NoError(t, err)
	require.NotContains(t, string(content), "do-not-export-receiver-config")
	var document exportDocument
	require.NoError(t, json.Unmarshal(content, &document))
	require.Equal(t, "alice", document.SourceOwnerID)
	require.Equal(t, "mail", document.SourceProviderID)
	require.Equal(t, "source-revision", document.Configuration.SourceRevisions["session.turn_finished"])
	require.Equal(t, "Subject {{task.title}}", document.Configuration.Templates["session.turn_finished"].Title)
	after, err := os.ReadFile(source)
	require.NoError(t, err)
	require.Equal(t, sha256.Sum256(before), sha256.Sum256(after))
	info, err := os.Stat(files[0])
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0600), info.Mode().Perm())
	require.Error(t, run([]string{"--snapshot", source, "--output", output}), "exports must not overwrite an existing directory")
	// Reopen only the test fixture after the read-only export has finished.
	db, err = sql.Open("sqlite", source)
	require.NoError(t, err)
	defer func() { _ = db.Close() }()
	_, err = db.Exec(`UPDATE kandev_meta SET value='unsupported-future-version'`)
	require.NoError(t, err)
	require.Error(t, run([]string{"--snapshot", source, "--output", filepath.Join(directory, "unsupported")}))
}
