package main

import (
	"sort"
)

type configurationExport struct {
	Schema           int                   `json:"schema"`
	SourceOwnerID    string                `json:"source_owner_id"`
	SourceProviderID string                `json:"source_provider_id"`
	SourceRevision   string                `json:"source_revision"`
	SourceDigest     string                `json:"source_digest"`
	Configuration    TemplateConfiguration `json:"configuration"`
}

type rollbackExport struct {
	Schema                   int                 `json:"schema"`
	Current                  configurationExport `json:"current"`
	Legacy                   configurationExport `json:"legacy"`
	RetainedAdditionalEvents []string            `json:"retained_additional_events"`
}

func exportConfiguration(owner, provider string, snapshot *PreparedSnapshot, target string) (any, error) {
	if err := validateConfiguration(snapshot.Configuration); err != nil {
		return nil, err
	}
	current := configurationExport{1, owner, provider, snapshot.Revision, snapshot.Digest, snapshot.Configuration}
	if target == "" {
		return current, nil
	}
	if target != "legacy-v1" {
		return nil, ErrTemplateInvalid
	}
	projected := TemplateConfiguration{Version: 1, Origin: current.Configuration.Origin, Templates: map[string]EventTemplate{}}
	additional := []string{}
	for event, template := range current.Configuration.Templates {
		switch event {
		case "session.turn_finished", "session.clarification_requested", "office.inbox_item", "system.update_available":
			projected.Templates[event] = template
			if revision, ok := current.Configuration.SourceRevisions[event]; ok {
				if projected.SourceRevisions == nil {
					projected.SourceRevisions = map[string]string{}
				}
				projected.SourceRevisions[event] = revision
			}
		default:
			additional = append(additional, event)
		}
	}
	_, digest, err := snapshotBytes(projected)
	if err != nil {
		return nil, err
	}
	sort.Strings(additional)
	legacy := configurationExport{1, owner, provider, snapshot.Revision, digest, projected}
	return rollbackExport{1, current, legacy, additional}, nil
}
