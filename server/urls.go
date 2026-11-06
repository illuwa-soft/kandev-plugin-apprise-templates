package main

import (
	"net"
	"net/url"
	"strconv"
	"strings"
)

func parseOrigin(origin string) (*url.URL, error) {
	if origin == "" {
		return nil, nil
	}
	if strings.ContainsAny(origin, "?#\r\n\t\x00 ") {
		return nil, ErrTemplateInvalid
	}
	u, err := url.Parse(origin)
	if err != nil || u.Hostname() == "" || u.User != nil || u.Opaque != "" || u.RawPath != "" || (u.Path != "" && u.Path != "/") {
		return nil, ErrTemplateInvalid
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return nil, ErrTemplateInvalid
		}
	} else if strings.HasSuffix(u.Host, ":") {
		return nil, ErrTemplateInvalid
	}
	u.Path = ""
	if u.Scheme == "https" {
		return u, nil
	}
	if u.Scheme == "http" && (strings.EqualFold(u.Hostname(), "localhost") || (net.ParseIP(u.Hostname()) != nil && net.ParseIP(u.Hostname()).IsLoopback())) {
		return u, nil
	}
	return nil, ErrTemplateInvalid
}

func ValidateOrigin(origin string) error {
	_, err := parseOrigin(origin)
	return err
}

func destination(origin, path string) string {
	u, err := parseOrigin(origin)
	if err != nil || u == nil {
		return ""
	}
	return u.String() + path
}

func taskURL(origin, task string) string {
	if task == "" {
		return ""
	}
	return destination(origin, "/t/"+url.PathEscape(task))
}

func sessionURL(origin, task, session string) string {
	if session == "" || task == "" || origin == "" {
		return ""
	}
	return taskURL(origin, task) + "?" + url.Values{"sessionId": {session}}.Encode()
}

func releaseURL(raw string) string {
	if strings.ContainsAny(raw, "\r\n\t\x00 ") {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Opaque != "" {
		return ""
	}
	if _, err := parseOrigin(u.Scheme + "://" + u.Host); err != nil {
		return ""
	}
	return u.String()
}
