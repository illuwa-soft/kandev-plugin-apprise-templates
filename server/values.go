package main

import (
	"net/url"
	"strconv"

	"github.com/kdlbs/kandev/pluginsdk"
)

func notificationValues(req *pluginsdk.NotificationFormatRequest, origin string) map[string]string {
	values := map[string]string{"event.type": req.EventType, "default.title": req.DefaultTitle, "default.body": req.DefaultBody}
	if task := req.Task; task != nil {
		values["task.id"], values["task.title"], values["task.url"] = task.TaskId, task.Title, taskURL(origin, task.TaskId)
		if task.TaskId != "" && task.SessionId != "" {
			values["session.id"] = task.SessionId
			values["session.url"] = sessionURL(origin, task.TaskId, task.SessionId)
			values["event.url"] = values["session.url"]
		}
	}
	if inbox := req.Inbox; inbox != nil {
		values["inbox.type"], values["inbox.title"] = inbox.Type, inbox.Title
		path := "/office/inbox"
		if inbox.WorkspaceId != "" {
			path += "?" + url.Values{"workspaceId": {inbox.WorkspaceId}}.Encode()
		}
		values["event.url"] = destination(origin, path)
	}
	if update := req.Update; update != nil {
		values["update.kind"], values["update.version"] = update.Kind, update.Version
		switch update.Kind {
		case "kandev":
			values["release.url"] = releaseURL(update.ReleaseUrl)
			values["event.url"] = destination(origin, "/settings/system/updates")
		case "agent_runtime":
			values["update.previous_version"], values["update.agent_name"], values["update.runtime_id"], values["update.status"], values["update.count"] = update.PreviousVersion, update.AgentName, update.RuntimeId, update.Status, "1"
			if update.AgentId != "" {
				values["event.url"] = destination(origin, "/settings/agents#runtime-update-"+url.PathEscape(update.AgentId))
			}
		case "agent_runtime_summary":
			values["update.version"] = ""
			values["update.status"], values["update.count"] = update.Status, strconv.FormatUint(uint64(update.Count), 10)
			values["event.url"] = destination(origin, "/settings/agents#runtime-updates")
		}
	}
	return values
}
