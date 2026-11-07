// Command legacy-export reads an offline SQLite snapshot, never a live host API.
package main

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

type legacyTemplate struct {
	Version int    `json:"version"`
	Title   string `json:"title"`
	Body    string `json:"body"`
}

type exportConfiguration struct {
	Version         int                       `json:"version"`
	Origin          string                    `json:"origin"`
	Templates       map[string]legacyTemplate `json:"templates"`
	SourceRevisions map[string]string         `json:"source_revisions"`
}

type exportDocument struct {
	Schema           int                 `json:"schema"`
	SourceOwnerID    string              `json:"source_owner_id"`
	SourceProviderID string              `json:"source_provider_id"`
	SourceDigest     string              `json:"source_digest"`
	Configuration    exportConfiguration `json:"configuration"`
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		log.Fatal("offline template export failed; verify snapshot, ownership, and a new private output path")
	}
}

func fileDigest(filename string) (string, error) {
	file, err := os.Open(filename)
	if err != nil {
		return "", err
	}
	defer func() { _ = file.Close() }()
	digest := sha256.New()
	if _, err = io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func run(args []string) error {
	flags := flag.NewFlagSet("legacy-export", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	source := flags.String("snapshot", "", "offline snapshot")
	output := flags.String("output", "", "new private output directory")
	origin := flags.String("origin", "", "validated public web origin")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if !filepath.IsAbs(*source) || !filepath.IsAbs(*output) || len(flags.Args()) != 0 {
		return errors.New("absolute snapshot and output paths required")
	}
	info, err := os.Lstat(*source)
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("regular offline snapshot required")
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if _, err := os.Lstat(*source + suffix); !errors.Is(err, os.ErrNotExist) {
			return errors.New("offline snapshot must not have SQLite sidecars")
		}
	}
	if *origin != "" {
		u, err := url.Parse(*origin)
		if err != nil || u.User != nil {
			return errors.New("credential-free origin required")
		}
	}
	digest, err := fileDigest(*source)
	if err != nil {
		return err
	}
	dsn := (&url.URL{Scheme: "file", Path: filepath.ToSlash(*source)}).String() + "?mode=ro&immutable=1"
	database, err := sql.Open("sqlite", dsn)
	if err != nil {
		return err
	}
	defer func() { _ = database.Close() }()
	documents, err := readTemplates(database, *origin, digest)
	if err != nil {
		return err
	}
	after, err := fileDigest(*source)
	if err != nil || after != digest {
		return errors.New("source snapshot changed")
	}
	if err = os.Mkdir(*output, 0700); err != nil {
		return err
	}
	keys := make([]string, 0, len(documents))
	for key := range documents {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		content, err := json.MarshalIndent(documents[key], "", "  ")
		if err != nil {
			return err
		}
		if len(content) > 128*1024 {
			return errors.New("export exceeds import size limit")
		}
		name := sha256.Sum256([]byte(key))
		file, err := os.OpenFile(filepath.Join(*output, "templates-"+hex.EncodeToString(name[:])+".json"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		_, writeErr := file.Write(content)
		syncErr := file.Sync()
		closeErr := file.Close()
		if writeErr != nil {
			return writeErr
		}
		if syncErr != nil {
			return syncErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	fmt.Printf("Exported %d provider configurations.\n", len(documents))
	return nil
}

func readTemplates(database *sql.DB, origin, digest string) (map[string]*exportDocument, error) {
	if err := validateLegacySchema(database); err != nil {
		return nil, err
	}
	var integrity string
	if err := database.QueryRow("PRAGMA quick_check").Scan(&integrity); err != nil || integrity != "ok" {
		return nil, errors.New("invalid snapshot")
	}
	rows, err := database.Query(`SELECT t.user_id,t.provider_id,t.event_type,t.template_json,t.revision,p.user_id,p.type
FROM notification_templates t LEFT JOIN notification_providers p ON p.id=t.provider_id ORDER BY t.user_id,t.provider_id,t.event_type`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	result := map[string]*exportDocument{}
	for rows.Next() {
		var owner, provider, event, raw, revision string
		var providerOwner, kind sql.NullString
		if err = rows.Scan(&owner, &provider, &event, &raw, &revision, &providerOwner, &kind); err != nil {
			return nil, err
		}
		if owner == "" || provider == "" || !providerOwner.Valid || providerOwner.String != owner || kind.String != "apprise" {
			return nil, errors.New("invalid source ownership")
		}
		if event != "session.turn_finished" && event != "session.clarification_requested" && event != "office.inbox_item" && event != "system.update_available" {
			return nil, errors.New("unsupported legacy event")
		}
		var template legacyTemplate
		decoder := json.NewDecoder(bytes.NewReader([]byte(raw)))
		decoder.DisallowUnknownFields()
		if !utf8.ValidString(raw) || decoder.Decode(&template) != nil || decoder.Decode(new(any)) != io.EOF || template.Version != 1 {
			return nil, errors.New("unsupported legacy template")
		}
		key := owner + "\x00" + provider
		if result[key] == nil {
			result[key] = &exportDocument{Schema: 1, SourceOwnerID: owner, SourceProviderID: provider, SourceDigest: digest, Configuration: exportConfiguration{Version: 1, Origin: origin, Templates: map[string]legacyTemplate{}, SourceRevisions: map[string]string{}}}
		}
		if _, duplicate := result[key].Configuration.Templates[event]; duplicate {
			return nil, errors.New("duplicate legacy template")
		}
		result[key].Configuration.Templates[event] = template
		result[key].Configuration.SourceRevisions[event] = revision
	}
	return result, rows.Err()
}
