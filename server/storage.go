package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

var ErrSnapshotNotFound = errors.New("template configuration not found")
var ErrImportConflict = errors.New("template import conflicts with existing configuration")

type EventTemplate struct {
	Version int    `json:"version"`
	Title   string `json:"title"`
	Body    string `json:"body"`
}

type TemplateConfiguration struct {
	SourceRevisions map[string]string        `json:"source_revisions,omitempty"`
	Version         int                      `json:"version"`
	Origin          string                   `json:"origin"`
	Templates       map[string]EventTemplate `json:"templates"`
}

type PreparedSnapshot struct {
	LatestPrepared *PreparedSnapshot     `json:"latest_prepared,omitempty"`
	Revision       string                `json:"revision"`
	Digest         string                `json:"digest"`
	Configuration  TemplateConfiguration `json:"configuration"`
}

func (s *SnapshotStore) Latest(ctx context.Context, owner, provider string) (*PreparedSnapshot, error) {
	var revision string
	err := s.db.QueryRowContext(ctx, `SELECT revision FROM snapshots WHERE owner_id=? AND provider_id=? ORDER BY rowid DESC LIMIT 1`, owner, provider).Scan(&revision)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrSnapshotNotFound
	}
	if err != nil {
		return nil, err
	}
	return s.Read(ctx, owner, provider, revision)
}

type SnapshotStore struct{ db *sql.DB }

func OpenSnapshotStore(directory string) (*SnapshotStore, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	filename := filepath.Join(directory, "templates.db")
	file, err := os.OpenFile(filename, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = file.Close(); err != nil {
		return nil, err
	}
	dsn := (&url.URL{Scheme: "file", Path: filepath.ToSlash(filename)}).String() + "?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
	database, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	database.SetMaxOpenConns(1)
	store := &SnapshotStore{db: database}
	if err = store.initialize(); err != nil {
		_ = database.Close()
		return nil, err
	}
	return store, nil
}

func (s *SnapshotStore) initialize() error {
	var version int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version > 1 {
		return errors.New("unsupported template database version")
	}
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS snapshots (
 owner_id TEXT NOT NULL, provider_id TEXT NOT NULL, revision TEXT PRIMARY KEY,
 digest TEXT NOT NULL, configuration TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS snapshots_owner_provider ON snapshots(owner_id,provider_id);
CREATE TABLE IF NOT EXISTS imports (
 owner_id TEXT NOT NULL, provider_id TEXT NOT NULL, source_digest TEXT NOT NULL,
 revision TEXT NOT NULL REFERENCES snapshots(revision),
 PRIMARY KEY(owner_id,provider_id,source_digest)
);
PRAGMA user_version=1;`)
	return err
}

func (s *SnapshotStore) Close() error { return s.db.Close() }

func validateConfiguration(configuration TemplateConfiguration) error {
	if configuration.Version != 1 || len(configuration.Templates) > len(templateEvents) {
		return ErrTemplateInvalid
	}
	if err := ValidateOrigin(configuration.Origin); err != nil {
		return err
	}
	for event, revision := range configuration.SourceRevisions {
		if _, exists := configuration.Templates[event]; !exists || len(revision) > 128 {
			return ErrTemplateInvalid
		}
	}
	for event, template := range configuration.Templates {
		if template.Version != 1 {
			return ErrTemplateInvalid
		}
		if err := ValidateTemplate(template.Title, template.Body, event); err != nil {
			return err
		}
	}
	return nil
}

func snapshotBytes(configuration TemplateConfiguration) ([]byte, string, error) {
	if err := validateConfiguration(configuration); err != nil {
		return nil, "", err
	}
	raw, err := json.Marshal(configuration)
	if err != nil {
		return nil, "", err
	}
	if len(raw) > 128*1024 {
		return nil, "", ErrTemplateInvalid
	}
	digest := sha256.Sum256(raw)
	return raw, hex.EncodeToString(digest[:]), nil
}

func (s *SnapshotStore) Prepare(ctx context.Context, owner, provider string, configuration TemplateConfiguration) (*PreparedSnapshot, error) {
	if owner == "" || provider == "" {
		return nil, ErrSnapshotNotFound
	}
	raw, digest, err := snapshotBytes(configuration)
	if err != nil {
		return nil, err
	}
	revision := uuid.NewString()
	_, err = s.db.ExecContext(ctx, `INSERT INTO snapshots(owner_id,provider_id,revision,digest,configuration) VALUES(?,?,?,?,?)`, owner, provider, revision, digest, string(raw))
	if err != nil {
		return nil, err
	}
	return s.Read(ctx, owner, provider, revision)
}

func (s *SnapshotStore) Read(ctx context.Context, owner, provider, revision string) (*PreparedSnapshot, error) {
	var raw string
	result := &PreparedSnapshot{Revision: revision}
	err := s.db.QueryRowContext(ctx, `SELECT digest,configuration FROM snapshots WHERE owner_id=? AND provider_id=? AND revision=?`, owner, provider, revision).Scan(&result.Digest, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrSnapshotNotFound
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal([]byte(raw), &result.Configuration); err != nil {
		return nil, ErrTemplateInvalid
	}
	_, digest, err := snapshotBytes(result.Configuration)
	if err != nil || digest != result.Digest {
		return nil, ErrTemplateInvalid
	}
	return result, nil
}
