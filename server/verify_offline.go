package main

import (
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"
)

// verifyOfflineStore uses the same configuration validation as live reads.
// It neither creates the database nor runs schema initialization or migrations.
func verifyOfflineStore(filename string) error {
	if !filepath.IsAbs(filename) {
		return errors.New("absolute offline snapshot required")
	}
	info, err := os.Lstat(filename)
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("regular offline snapshot required")
	}
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		if _, err := os.Lstat(filename + suffix); !errors.Is(err, os.ErrNotExist) {
			return errors.New("offline snapshot has sidecars")
		}
	}
	dsn := (&url.URL{Scheme: "file", Path: filepath.ToSlash(filename)}).String() + "?mode=ro&immutable=1"
	database, err := sql.Open("sqlite", dsn)
	if err != nil {
		return err
	}
	defer func() { _ = database.Close() }()
	var version int
	if err := database.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 1 {
		return errors.New("unsupported offline schema")
	}
	rows, err := database.Query("SELECT owner_id,provider_id,revision,digest,configuration FROM snapshots")
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var owner, provider, revision, digest, raw string
		if err := rows.Scan(&owner, &provider, &revision, &digest, &raw); err != nil {
			return err
		}
		var configuration TemplateConfiguration
		if owner == "" || provider == "" || revision == "" || decodeActionBody([]byte(raw), &configuration) != nil {
			return ErrTemplateInvalid
		}
		_, actual, err := snapshotBytes(configuration)
		if err != nil || actual != digest {
			return ErrTemplateInvalid
		}
	}
	return rows.Err()
}
