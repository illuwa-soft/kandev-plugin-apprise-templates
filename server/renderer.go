package main

import (
	"errors"
	"slices"
	"strings"
	"unicode/utf8"
)

var ErrTemplateInvalid = errors.New("invalid notification template")
var ErrValueUnavailable = errors.New("notification value unavailable")

var templateEvents = []string{"session.turn_finished", "session.clarification_requested", "session.permission_requested", "session.failed", "office.inbox_item", "system.update_available"}

func TemplateVariables(event string) []string {
	if !slices.Contains(templateEvents, event) {
		return nil
	}
	keys := []string{"event.type", "event.url", "default.title", "default.body"}
	switch event {
	case "office.inbox_item":
		return append(keys, "inbox.type", "inbox.title")
	case "system.update_available":
		return append(keys, "update.kind", "update.version", "update.previous_version", "update.agent_name", "update.runtime_id", "update.status", "update.count", "release.url")
	default:
		return append(keys, "task.id", "task.title", "task.url", "session.id", "session.url")
	}
}

type templatePart struct{ literal, key string }

func parseTemplate(source string) ([]templatePart, error) {
	if !utf8.ValidString(source) || strings.ContainsRune(source, 0) || len(source) > 16384 {
		return nil, ErrTemplateInvalid
	}
	var literal strings.Builder
	var parts []templatePart
	count := 0
	for i := 0; i < len(source); {
		switch source[i] {
		case '\\':
			if i+1 == len(source) || !strings.ContainsRune(`{}\`, rune(source[i+1])) {
				return nil, ErrTemplateInvalid
			}
			literal.WriteByte(source[i+1])
			i += 2
		case '{':
			if !strings.HasPrefix(source[i:], "{{") {
				return nil, ErrTemplateInvalid
			}
			end := strings.Index(source[i+2:], "}}")
			if end < 0 || count >= 64 {
				return nil, ErrTemplateInvalid
			}
			key := strings.Trim(source[i+2:i+2+end], " ")
			if !validTemplateKey(key) {
				return nil, ErrTemplateInvalid
			}
			parts = append(parts, templatePart{literal: literal.String()}, templatePart{key: key})
			literal.Reset()
			count++
			i += end + 4
		case '}':
			return nil, ErrTemplateInvalid
		default:
			literal.WriteByte(source[i])
			i++
		}
	}
	return append(parts, templatePart{literal: literal.String()}), nil
}

func validTemplateKey(key string) bool {
	if key == "" {
		return false
	}
	for _, c := range key {
		if (c < 'a' || c > 'z') && c != '.' && c != '_' {
			return false
		}
	}
	return true
}

func ValidateTemplate(title, body, event string) error {
	allowed := TemplateVariables(event)
	if len(allowed) == 0 || strings.TrimSpace(title) == "" || strings.TrimSpace(body) == "" || len(title) > 1024 || len(body) > 16384 || strings.ContainsAny(title, "\r\n") {
		return ErrTemplateInvalid
	}
	for _, source := range []string{title, body} {
		parts, err := parseTemplate(source)
		if err != nil {
			return err
		}
		for _, part := range parts {
			if part.key != "" && !slices.Contains(allowed, part.key) {
				return ErrTemplateInvalid
			}
		}
	}
	return nil
}

func renderTemplateField(source string, values map[string]string, limit int) (string, error) {
	parts, err := parseTemplate(source)
	if err != nil {
		return "", err
	}
	var result strings.Builder
	for _, part := range parts {
		value := part.literal
		if part.key != "" {
			value = values[part.key]
			if value == "" {
				return "", ErrValueUnavailable
			}
		}
		if !utf8.ValidString(value) || strings.ContainsRune(value, 0) || len(value) > limit-result.Len() {
			return "", ErrTemplateInvalid
		}
		result.WriteString(value)
	}
	return result.String(), nil
}

func RenderTemplate(title, body, event string, values map[string]string) (string, string, error) {
	if err := ValidateTemplate(title, body, event); err != nil {
		return "", "", err
	}
	title, err := renderTemplateField(title, values, 2048)
	if err != nil || strings.ContainsAny(title, "\r\n") {
		return "", "", ErrValueUnavailable
	}
	body, err = renderTemplateField(body, values, 65536)
	if err != nil {
		return "", "", err
	}
	return title, body, nil
}
