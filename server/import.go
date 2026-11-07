package main

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"

	"github.com/google/uuid"
)

// Import creates one prepared snapshot and receipt, never an active selection.
func (s *SnapshotStore) Import(ctx context.Context, owner, provider, source string, configuration TemplateConfiguration) (*PreparedSnapshot, error) {
	decoded, err := hex.DecodeString(source)
	if err != nil || len(decoded) != 32 || owner == "" || provider == "" {
		return nil, ErrTemplateInvalid
	}
	raw, digest, err := snapshotBytes(configuration)
	if err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	var revision, priorDigest string
	err = tx.QueryRowContext(ctx, `SELECT i.revision,s.digest FROM imports i JOIN snapshots s ON s.revision=i.revision
WHERE i.owner_id=? AND i.provider_id=? AND i.source_digest=?`, owner, provider, source).Scan(&revision, &priorDigest)
	if err == nil {
		var latestRevision string
		if err = tx.QueryRowContext(ctx, `SELECT revision FROM snapshots WHERE owner_id=? AND provider_id=? ORDER BY rowid DESC LIMIT 1`, owner, provider).Scan(&latestRevision); err != nil {
			return nil, err
		}
		if priorDigest != digest || latestRevision != revision {
			return nil, ErrImportConflict
		}
		if err = tx.Commit(); err != nil {
			return nil, err
		}
		return s.Read(ctx, owner, provider, revision)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM snapshots WHERE owner_id=? AND provider_id=?`, owner, provider).Scan(&count); err != nil {
		return nil, err
	}
	if count != 0 {
		return nil, ErrImportConflict
	}
	revision = uuid.NewString()
	_, err = tx.ExecContext(ctx, `INSERT INTO snapshots(owner_id,provider_id,revision,digest,configuration) VALUES(?,?,?,?,?)`, owner, provider, revision, digest, string(raw))
	if err != nil {
		return nil, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO imports(owner_id,provider_id,source_digest,revision) VALUES(?,?,?,?)`, owner, provider, source, revision)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return s.Read(ctx, owner, provider, revision)
}
