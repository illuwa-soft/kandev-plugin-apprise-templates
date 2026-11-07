package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/kdlbs/kandev/pluginsdk"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const formatterKey = "apprise-text"

type formatterPlugin struct {
	pluginsdk.UnimplementedPlugin
	store *SnapshotStore
}

func (p *formatterPlugin) FormatNotification(ctx context.Context, req *pluginsdk.NotificationFormatRequest) (*pluginsdk.NotificationFormatResponse, error) {
	if req == nil || req.ContractVersion != 1 || req.FormatterKey != formatterKey || req.OwnerId == "" || req.ProviderId == "" {
		return nil, status.Error(codes.InvalidArgument, "invalid notification context")
	}
	var configuration TemplateConfiguration
	if req.Preview {
		if err := decodeActionBody(req.PreviewConfiguration, &configuration); err != nil {
			return nil, status.Error(codes.InvalidArgument, "invalid preview configuration")
		}
		if err := validateConfiguration(configuration); err != nil {
			return nil, status.Error(codes.InvalidArgument, "invalid preview configuration")
		}
		if req.PreviewSample == "missing_url" {
			configuration.Origin = ""
		}
	} else {
		snapshot, err := p.store.Read(ctx, req.OwnerId, req.ProviderId, req.ConfigurationRevision)
		if err != nil {
			return nil, status.Error(codes.FailedPrecondition, "notification configuration unavailable")
		}
		configuration = snapshot.Configuration
	}
	template, ok := configuration.Templates[req.EventType]
	if !ok {
		return &pluginsdk.NotificationFormatResponse{}, nil
	}
	title, body, err := RenderTemplate(template.Title, template.Body, req.EventType, notificationValues(req, configuration.Origin))
	if err != nil {
		return &pluginsdk.NotificationFormatResponse{}, nil
	}
	return &pluginsdk.NotificationFormatResponse{Custom: true, Title: title, Body: body}, nil
}

func (p *formatterPlugin) InspectNotificationConfiguration(ctx context.Context, req *pluginsdk.NotificationConfigurationRequest) (*pluginsdk.NotificationConfigurationResponse, error) {
	if req == nil || req.FormatterKey != formatterKey {
		return nil, status.Error(codes.InvalidArgument, "invalid formatter reference")
	}
	snapshot, err := p.store.Read(ctx, req.OwnerId, req.ProviderId, req.Revision)
	if err != nil {
		return nil, status.Error(codes.NotFound, "notification configuration unavailable")
	}
	return &pluginsdk.NotificationConfigurationResponse{Revision: snapshot.Revision, Digest: snapshot.Digest}, nil
}

func (p *formatterPlugin) HandleAction(ctx context.Context, req *pluginsdk.PluginActionRequest) (*pluginsdk.PluginActionResponse, error) {
	if req == nil || req.Context.ActorID == "" || req.Context.NotificationProviderID == "" {
		return actionResult(http.StatusForbidden, map[string]string{"error": "provider authorization required"})
	}
	owner, provider := req.Context.ActorID, req.Context.NotificationProviderID
	switch req.ActionKey {
	case "templates.catalog":
		variables := map[string][]string{}
		for _, event := range templateEvents {
			variables[event] = TemplateVariables(event)
		}
		return actionResult(http.StatusOK, map[string]any{"events": templateEvents, "variables": variables})
	case "templates.get", "templates.export":
		var input struct {
			Revision string `json:"revision"`
			Target   string `json:"target,omitempty"`
		}
		if err := decodeActionBody(req.Body, &input); err != nil {
			return invalidAction()
		}
		if req.ActionKey == "templates.export" {
			snapshot, err := p.store.Read(ctx, owner, provider, input.Revision)
			if err != nil {
				return snapshotAction(nil, err)
			}
			value, err := exportConfiguration(owner, provider, snapshot, input.Target)
			if err != nil {
				return invalidAction()
			}
			return actionResult(http.StatusOK, value)
		}
		if input.Target != "" {
			return invalidAction()
		}
		return p.readConfigurationAction(ctx, owner, provider, input.Revision)
	case "templates.prepare", "templates.import":
		var input struct {
			Configuration    TemplateConfiguration `json:"configuration"`
			SourceDigest     string                `json:"source_digest,omitempty"`
			Schema           int                   `json:"schema,omitempty"`
			SourceOwnerID    string                `json:"source_owner_id,omitempty"`
			SourceProviderID string                `json:"source_provider_id,omitempty"`
			SourceRevision   string                `json:"source_revision,omitempty"`
		}
		if err := decodeActionBody(req.Body, &input); err != nil {
			return invalidAction()
		}
		var snapshot *PreparedSnapshot
		var err error
		if req.ActionKey == "templates.import" {
			if input.Schema != 1 || input.SourceOwnerID != owner || input.SourceProviderID != provider {
				return invalidAction()
			}
			snapshot, err = p.store.Import(ctx, owner, provider, input.SourceDigest, input.Configuration)
		} else {
			snapshot, err = p.store.Prepare(ctx, owner, provider, input.Configuration)
		}
		return snapshotAction(snapshot, err)
	default:
		return actionResult(http.StatusNotFound, map[string]string{"error": "template action not found"})
	}
}

func (p *formatterPlugin) readConfigurationAction(ctx context.Context, owner, provider, revision string) (*pluginsdk.PluginActionResponse, error) {
	latest, err := p.store.Latest(ctx, owner, provider)
	if revision == "" {
		if errors.Is(err, ErrSnapshotNotFound) {
			return actionResult(http.StatusOK, &PreparedSnapshot{Configuration: TemplateConfiguration{Version: 1, Templates: map[string]EventTemplate{}}})
		}
		return snapshotAction(latest, err)
	}
	snapshot, err := p.store.Read(ctx, owner, provider, revision)
	if err != nil {
		return snapshotAction(nil, err)
	}
	if latest != nil && latest.Revision != revision {
		snapshot.LatestPrepared = latest
	}
	return actionResult(http.StatusOK, snapshot)
}

func decodeActionBody(raw []byte, target any) error {
	if len(raw) > 128*1024 {
		return ErrTemplateInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return ErrTemplateInvalid
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return ErrTemplateInvalid
	}
	return nil
}

func actionResult(code int, value any) (*pluginsdk.PluginActionResponse, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return nil, errors.New("template response unavailable")
	}
	return &pluginsdk.PluginActionResponse{Status: code, Body: body, Headers: map[string]string{"Content-Type": "application/json", "Cache-Control": "no-store"}}, nil
}

func invalidAction() (*pluginsdk.PluginActionResponse, error) {
	return actionResult(http.StatusBadRequest, map[string]string{"error": "invalid template configuration"})
}

func snapshotAction(snapshot *PreparedSnapshot, err error) (*pluginsdk.PluginActionResponse, error) {
	switch {
	case err == nil:
		return actionResult(http.StatusOK, snapshot)
	case errors.Is(err, ErrImportConflict):
		return actionResult(http.StatusConflict, map[string]string{"error": "template import conflict"})
	case errors.Is(err, ErrSnapshotNotFound):
		return actionResult(http.StatusNotFound, map[string]string{"error": "template configuration not found"})
	case errors.Is(err, ErrTemplateInvalid):
		return invalidAction()
	default:
		return actionResult(http.StatusServiceUnavailable, map[string]string{"error": "template storage unavailable"})
	}
}
