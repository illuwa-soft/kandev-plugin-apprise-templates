package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	"gopkg.in/yaml.v3"
)

type backupFileReference struct {
	Path       string `json:"path"`
	SourcePath string `json:"source_path"`
}

type backupInstallation struct {
	Schema         int                            `json:"schema"`
	PluginID       string                         `json:"plugin_id"`
	PluginVersion  string                         `json:"plugin_version"`
	InstallationID string                         `json:"installation_id"`
	Files          map[string]backupFileReference `json:"files"`
}

type installationRecord struct {
	ID             string `yaml:"id"`
	APIVersion     int    `yaml:"api_version"`
	Version        string `yaml:"version"`
	InstallationID string `yaml:"installation_id"`
	InstallPath    string `yaml:"install_path"`
	Runtime        struct {
		Type        string            `yaml:"type"`
		Executables map[string]string `yaml:"executables"`
	} `yaml:"runtime"`
	Formatters []struct {
		Key           string   `yaml:"key"`
		Version       int      `yaml:"contract_version"`
		ProviderTypes []string `yaml:"provider_types"`
	} `yaml:"notification_formatters"`
}

func readBackupMetadata(filename string) ([]byte, error) {
	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	raw, err := io.ReadAll(io.LimitReader(file, 1024*1024+1))
	if err != nil || len(raw) > 1024*1024 {
		return nil, ErrTemplateInvalid
	}
	return raw, nil
}

func backupReferencePath(base, relative string) (string, error) {
	if !filepath.IsLocal(relative) {
		return "", ErrTemplateInvalid
	}
	resolved, err := filepath.EvalSymlinks(filepath.Join(base, relative))
	if err != nil {
		return "", err
	}
	inside, err := filepath.Rel(base, resolved)
	if err != nil || !filepath.IsLocal(inside) {
		return "", ErrTemplateInvalid
	}
	return resolved, nil
}

func verifyBackupInstallation(filename string) error {
	filename, err := filepath.EvalSymlinks(filename)
	if err != nil {
		return err
	}
	raw, err := readBackupMetadata(filename)
	if err != nil {
		return err
	}
	var backup backupInstallation
	if json.Unmarshal(raw, &backup) != nil || backup.Schema != 1 {
		return ErrTemplateInvalid
	}
	base := filepath.Dir(filename)
	recordPath, err := backupReferencePath(base, backup.Files["plugin_record"].Path)
	if err != nil {
		return err
	}
	raw, err = readBackupMetadata(recordPath)
	if err != nil {
		return err
	}
	var record installationRecord
	if yaml.Unmarshal(raw, &record) != nil {
		return ErrTemplateInvalid
	}
	if record.ID != backup.PluginID || record.InstallationID != backup.InstallationID || record.Version != backup.PluginVersion || (record.APIVersion != 1 && record.APIVersion != 2) || record.Runtime.Type != "binary" {
		return errors.New("backup installation identity mismatch")
	}
	executable := record.Runtime.Executables[runtime.GOOS+"-"+runtime.GOARCH]
	if !filepath.IsAbs(record.InstallPath) || !filepath.IsLocal(executable) || !strings.HasPrefix(executable, "server/") {
		return errors.New("unsupported backup runtime reference")
	}
	if filepath.Clean(filepath.Join(record.InstallPath, filepath.FromSlash(executable))) != filepath.Clean(backup.Files["plugin_binary"].SourcePath) {
		return errors.New("backup executable reference mismatch")
	}
	hostPath, err := backupReferencePath(base, backup.Files["host_database"].Path)
	if err != nil {
		return err
	}
	return verifyInstallationBindings(hostPath, &record)
}

func verifyInstallationBindings(filename string, record *installationRecord) error {
	dsn := (&url.URL{Scheme: "file", Path: filepath.ToSlash(filename)}).String() + "?mode=ro&immutable=1"
	database, err := sql.Open("sqlite", dsn)
	if err != nil {
		return err
	}
	defer func() { _ = database.Close() }()
	rows, err := database.Query(`SELECT plugin_id,installation_id,formatter_key,provider_type FROM notification_formatter_bindings WHERE plugin_id<>''`)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var plugin, installation, key, kind string
		if err := rows.Scan(&plugin, &installation, &key, &kind); err != nil {
			return err
		}
		if plugin != record.ID || installation != record.InstallationID {
			return ErrTemplateInvalid
		}
		matches := 0
		for _, formatter := range record.Formatters {
			if formatter.Key == key && formatter.Version == 1 && slices.Contains(formatter.ProviderTypes, kind) {
				matches++
			}
		}
		if matches != 1 {
			return errors.New("backup formatter declaration mismatch")
		}
	}
	return rows.Err()
}
