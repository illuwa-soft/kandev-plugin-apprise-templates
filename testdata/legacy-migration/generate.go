// This fixture adapter executes the pinned renderer and URL helpers, not the plugin.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"

	"oracle/templates"
)

type renderCase struct {
	Name, Event, Title, Body, ExpectedTitle, ExpectedBody string
	TitleDigest, BodyDigest                               string `json:",omitempty"`
	Values                                                map[string]string
	Repeat                                                map[string]int `json:",omitempty"`
	Fallback                                              bool
}

type urlCase struct{ Origin, Task, Session, Release, TaskURL, SessionURL, ReleaseURL string }

func hash(raw string) string {
	result := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(result[:])
}

func main() {
	events := []string{"session.turn_finished", "session.clarification_requested", "office.inbox_item", "system.update_available"}
	cases := []renderCase{}
	for _, event := range events {
		for _, sample := range []string{"literal", "missing", "escape", "unknown-variable", "value-injection", "missing-origin"} {
			item := renderCase{Name: event + "/" + sample, Event: event, Title: "{{event.type}}", Body: "{{default.body}}", Values: map[string]string{"event.type": event, "default.body": "Synthetic 본문 {{not_reparsed}}"}}
			switch sample {
			case "missing":
				delete(item.Values, "default.body")
			case "escape":
				item.Body = `\{\{literal\}\} \\ {{ event.type }}`
			case "unknown-variable":
				item.Body = "{{receiver.secret}}"
			case "value-injection":
				item.Values["default.body"] = "<b>literal</b> {{task.id}}; $(ignored)"
			case "missing-origin":
				item.Body = "{{event.url}}"
			}
			cases = append(cases, item)
		}
	}
	for _, item := range []renderCase{
		{Name: "title-output-boundary", Title: "{{task.title}}", Body: "Body", Repeat: map[string]int{"task.title": 2048}},
		{Name: "title-output-overflow", Title: "{{task.title}}", Body: "Body", Repeat: map[string]int{"task.title": 2049}},
		{Name: "body-output-boundary", Title: "Title", Body: "{{default.body}}", Repeat: map[string]int{"default.body": 65536}},
		{Name: "body-output-overflow", Title: "Title", Body: "{{default.body}}", Repeat: map[string]int{"default.body": 65537}},
		{Name: "title-newline-value", Title: "{{task.title}}", Body: "Body", Values: map[string]string{"task.title": "line\nbreak"}},
		{Name: "unsupported-event", Event: "unknown.event", Title: "Title", Body: "Body"},
		{Name: "tab-in-placeholder", Title: "Title", Body: "{{\tevent.type}}"},
		{Name: "placeholder-budget", Title: "Title", Body: strings.Repeat("{{event.type}}", 65)},
	} {
		if item.Event == "" {
			item.Event = events[0]
		}
		if item.Values == nil {
			item.Values = map[string]string{"event.type": item.Event}
		}
		cases = append(cases, item)
	}
	for _, status := range []string{"available", "succeeded", "failed", "interrupted"} {
		cases = append(cases, renderCase{Name: "runtime/" + status, Event: "system.update_available", Title: "{{update.agent_name}} {{update.status}}", Body: "{{update.previous_version}} -> {{update.version}} {{event.url}}", Values: map[string]string{
			"update.agent_name": "Synthetic Agent", "update.status": status, "update.previous_version": "1.0.0", "update.version": "2.0.0",
			"event.url": templates.Destination("https://example.invalid", "/settings/agents#runtime-update-fixture"),
		}})
	}
	cases = append(cases, renderCase{Name: "runtime/summary", Event: "system.update_available", Title: "{{update.count}} {{update.status}}", Body: "{{event.url}}", Values: map[string]string{"update.count": "3", "update.status": "available", "event.url": templates.Destination("https://example.invalid", "/settings/agents#runtime-updates")}})
	cases = append(cases, renderCase{Name: "release/kandev", Event: "system.update_available", Title: "{{update.kind}} {{update.version}}", Body: "{{release.url}}", Values: map[string]string{"update.kind": "kandev", "update.version": "0.99.1", "release.url": templates.ReleaseURL("https://example.invalid/releases/v0.99.1")}})
	for index := range cases {
		item := &cases[index]
		values := map[string]string{}
		for key, value := range item.Values {
			values[key] = value
		}
		for key, count := range item.Repeat {
			values[key] = strings.Repeat("x", count)
		}
		err := templates.Validate(item.Title, item.Body, templates.Variables(item.Event))
		if err == nil {
			item.ExpectedTitle, err = templates.Render(item.Title, values, 2048)
		}
		if err == nil {
			item.ExpectedBody, err = templates.Render(item.Body, values, 65536)
		}
		item.Fallback = err != nil || strings.ContainsAny(item.ExpectedTitle, "\r\n")
		if item.Fallback {
			item.ExpectedTitle = ""
			item.ExpectedBody = ""
		}
		if len(item.ExpectedTitle) > 512 {
			item.TitleDigest = hash(item.ExpectedTitle)
			item.ExpectedTitle = ""
		}
		if len(item.ExpectedBody) > 512 {
			item.BodyDigest = hash(item.ExpectedBody)
			item.ExpectedBody = ""
		}
	}
	urls := []urlCase{
		{Origin: "https://example.invalid/", Task: "task /?#한글", Session: "session +&=?", Release: "https://example.invalid/releases/v1?q=x"},
		{Origin: "", Task: "task", Session: "session"},
		{Origin: "http://127.0.0.1:38429", Task: "task", Session: "session"},
		{Origin: "http://public.invalid", Task: "task", Session: "session", Release: "https://user:secret@example.invalid/x"},
		{Origin: "https://example.invalid", Task: "task", Session: ""},
		{Origin: "https://example.invalid", Task: "", Session: "session"},
	}
	for index := range urls {
		item := &urls[index]
		item.TaskURL = templates.TaskURL(item.Origin, item.Task)
		item.SessionURL = templates.SessionURL(item.Origin, item.Task, item.Session)
		item.ReleaseURL = templates.ReleaseURL(item.Release)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(map[string]any{"SourceRevision": os.Args[1], "Cases": cases, "URLs": urls}); err != nil {
		panic(err)
	}
}
