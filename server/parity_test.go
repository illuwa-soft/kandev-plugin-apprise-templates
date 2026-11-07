package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLegacyRenderingParity(t *testing.T) {
	raw, err := os.ReadFile("../testdata/legacy-migration/oracle.json")
	require.NoError(t, err)
	var fixture struct {
		SourceRevision string
		Sources        map[string]string
		Cases          []struct {
			Name, Event, Title, Body, ExpectedTitle, ExpectedBody string
			TitleDigest, BodyDigest                               string
			Values                                                map[string]string
			Repeat                                                map[string]int
			Fallback                                              bool
		}
		URLs []struct{ Origin, Task, Session, Release, TaskURL, SessionURL, ReleaseURL string }
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.Equal(t, "15495808e383c0af926a617b54cd8b2adacd9db3", fixture.SourceRevision)
	require.Equal(t, "25cd3bb33b07c40e27003bc44b040a5a8c6ec0500fc8ba40fcb21d378815c211", fixture.Sources["apps/backend/internal/notifications/templates/renderer.go"])
	require.Equal(t, "e60e45679af2c4518760f4b62a73c5390d5e18f1caf0e1fa2bc7357c74e92cff", fixture.Sources["apps/backend/internal/notifications/templates/urls.go"])
	require.Equal(t, "50ee94520884401c6c1230b0ad28562bd7dcc0216de194af98b05336184d70fc", fixture.Sources["apps/backend/internal/common/weburl/origin.go"])
	require.GreaterOrEqual(t, len(fixture.Cases), 20)
	for _, item := range fixture.Cases {
		t.Run(item.Name, func(t *testing.T) {
			for key, count := range item.Repeat {
				item.Values[key] = strings.Repeat("x", count)
			}
			title, body, err := RenderTemplate(item.Title, item.Body, item.Event, item.Values)
			require.Equal(t, item.Fallback, err != nil)
			if !item.Fallback {
				if item.TitleDigest != "" {
					sum := sha256.Sum256([]byte(title))
					require.Equal(t, item.TitleDigest, hex.EncodeToString(sum[:]))
				} else {
					require.Equal(t, item.ExpectedTitle, title)
				}
				if item.BodyDigest != "" {
					sum := sha256.Sum256([]byte(body))
					require.Equal(t, item.BodyDigest, hex.EncodeToString(sum[:]))
				} else {
					require.Equal(t, item.ExpectedBody, body)
				}
			}
		})
	}
	for _, item := range fixture.URLs {
		t.Run("url/"+item.Origin+"/"+item.Task, func(t *testing.T) {
			require.Equal(t, item.TaskURL, taskURL(item.Origin, item.Task))
			require.Equal(t, item.SessionURL, sessionURL(item.Origin, item.Task, item.Session))
			require.Equal(t, item.ReleaseURL, releaseURL(item.Release))
		})
	}
}
