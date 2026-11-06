package main

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLiteralTemplateRendering(t *testing.T) {
	title, body, err := RenderTemplate("[{{event.type}}] {{ task.title }}", "Open {{session.url}}", "session.permission_requested", map[string]string{
		"event.type": "session.permission_requested", "task.title": "Literal {{never.executed}}", "session.url": "https://example.invalid/t/task?sessionId=session",
	})
	require.NoError(t, err)
	require.Equal(t, "[session.permission_requested] Literal {{never.executed}}", title)
	require.Equal(t, "Open https://example.invalid/t/task?sessionId=session", body)
	_, _, err = RenderTemplate("Title", "{{session.url}}", "session.failed", map[string]string{})
	require.ErrorIs(t, err, ErrValueUnavailable)
	for _, source := range []string{"{{config.password}}", "{{ task.title | upper }}", "{{task.title", "{broken}", "{{update.version}}"} {
		_, _, err := RenderTemplate("Title", source, "session.failed", map[string]string{})
		require.Error(t, err, source)
	}
}
