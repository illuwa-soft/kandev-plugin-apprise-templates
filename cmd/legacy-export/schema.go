package main

import (
	"database/sql"
	"errors"
	"strings"
)

// The schema is pinned to deployed source 15495808e383c0af926a617b54cd8b2adacd9db3.
// Supporting another source version requires reviewing its exporter contract.
func validateLegacySchema(database *sql.DB) error {
	for _, table := range []string{"kandev_meta", "notification_providers", "notification_templates"} {
		var kind string
		if err := database.QueryRow(`SELECT type FROM sqlite_master WHERE name=?`, table).Scan(&kind); err != nil || kind != "table" {
			return errors.New("unsupported legacy table layout")
		}
	}
	var version string
	if err := database.QueryRow(`SELECT value FROM kandev_meta WHERE key='kandev_version'`).Scan(&version); err != nil {
		return errors.New("missing legacy source version")
	}
	if strings.TrimPrefix(version, "v") != "0.98.0+upstream-history.apprise-templates.1" {
		return errors.New("unsupported legacy source version")
	}
	rows, err := database.Query(`PRAGMA table_info(notification_templates)`)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	names := []string{"provider_id", "user_id", "event_type", "template_json", "revision", "created_at", "updated_at"}
	count := 0
	for rows.Next() {
		var index, notNull, primary int
		var name, kind string
		var defaultValue any
		if err := rows.Scan(&index, &name, &kind, &notNull, &defaultValue, &primary); err != nil {
			return err
		}
		if count >= len(names) || index != count || name != names[count] || notNull != 1 {
			return errors.New("unsupported legacy template columns")
		}
		wantType, wantPrimary := "TEXT", 0
		if count >= 5 {
			wantType = "TIMESTAMP"
		}
		if count == 0 {
			wantPrimary = 1
		} else if count == 2 {
			wantPrimary = 2
		}
		if strings.ToUpper(kind) != wantType || primary != wantPrimary {
			return errors.New("unsupported legacy template column contract")
		}
		count++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if count != len(names) {
		return errors.New("missing legacy template columns")
	}
	return nil
}
