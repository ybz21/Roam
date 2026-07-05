// Package plugin implements the Roam plugin foundation (设计见
// docs/design/plugin/):manifest、注册表、宿主 API、插件子进程托管与守护进程。
//
// v0 范围(对应设计文档 MVP-A/B 切片):builtin(Go)插件、commands 与
// notificationSinks 贡献点、workspace/agent/session/command/finding/
// notification 平台 API、命令白名单强制、审计。MCP 桥、node/exec 运行时、
// webhook、事件日志分库为后续增量。
package plugin

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// LocaleText is a locale-keyed display string ({"zh-CN": ..., "en-US": ...}).
type LocaleText map[string]string

// Get returns the text for locale, falling back to zh-CN then any.
func (l LocaleText) Get(locale string) string {
	if l == nil {
		return ""
	}
	if v := l[locale]; v != "" {
		return v
	}
	if v := l["zh-CN"]; v != "" {
		return v
	}
	for _, v := range l {
		return v
	}
	return ""
}

// Manifest mirrors roam-plugin.json (docs/design/plugin/05-manifest.md 的子集).
type Manifest struct {
	ManifestVersion  int        `json:"manifestVersion"`
	ID               string     `json:"id"`
	Publisher        string     `json:"publisher"`
	Name             string     `json:"name"`
	DisplayName      LocaleText `json:"displayName,omitempty"`
	Version          string     `json:"version"`
	Description      LocaleText `json:"description,omitempty"`
	Main             string     `json:"main,omitempty"`
	Runtime          Runtime    `json:"runtime"`
	Permissions      Perms      `json:"permissions"`
	ActivationEvents []string   `json:"activationEvents,omitempty"`
	Contributes      Contribs   `json:"contributes"`
}

// Runtime describes how the plugin process is launched.
type Runtime struct {
	Kind     string `json:"kind"` // builtin | node | exec
	Resident bool   `json:"resident,omitempty"`
}

// Perms is the declared permission ceiling (v1 宿主 API 侧强制,见 07-security).
type Perms struct {
	Workspace     []string     `json:"workspace,omitempty"` // read | write
	Commands      CommandPerms `json:"commands,omitempty"`
	Network       NetworkPerms `json:"network,omitempty"`
	Sessions      []string     `json:"sessions,omitempty"`      // read | write
	Agents        []string     `json:"agents,omitempty"`        // spawn
	Findings      []string     `json:"findings,omitempty"`      // read | write
	Notifications []string     `json:"notifications,omitempty"` // publish | subscribe
	Secrets       []string     `json:"secrets,omitempty"`
}

// CommandPerms whitelists host-executed commands by argv prefix.
type CommandPerms struct {
	Allow []string `json:"allow,omitempty"`
	Deny  []string `json:"deny,omitempty"`
}

// NetworkPerms declares outbound domains (v1 仅声明与审计,不阻断).
type NetworkPerms struct {
	AllowedDomains []string `json:"allowedDomains,omitempty"`
}

// Contribs are the static contribution points.
type Contribs struct {
	Commands          []CommandContrib `json:"commands,omitempty"`
	NotificationSinks []SinkContrib    `json:"notificationSinks,omitempty"`
	ConfigFields      []ConfigField    `json:"configFields,omitempty"`
}

// ConfigField declares one settings entry; 宿主(CLI/Web 设置页)据此渲染
// 配置表单,插件零前端(完整 JSON Schema 校验为后续增量)。
type ConfigField struct {
	Key         string     `json:"key"`
	Title       LocaleText `json:"title,omitempty"`
	Description LocaleText `json:"description,omitempty"`
	Secret      bool       `json:"secret,omitempty"`  // 展示打码,输入用密码框
	Options     []string   `json:"options,omitempty"` // 非空则渲染为下拉选择
	Placeholder string     `json:"placeholder,omitempty"`
}

// CommandContrib declares a human-facing command (CLI / Web).
type CommandContrib struct {
	ID    string     `json:"id"`
	Title LocaleText `json:"title,omitempty"`
}

// SinkContrib subscribes the plugin to notification types as an outbound sink.
type SinkContrib struct {
	ID     string   `json:"id"`
	Events []string `json:"events,omitempty"` // notification types; "*" matches all
}

// Validate checks structural invariants shared by builtin and external plugins.
func (m Manifest) Validate() error {
	if m.ID == "" || !strings.Contains(m.ID, ".") {
		return fmt.Errorf("manifest: id must be <publisher>.<name>, got %q", m.ID)
	}
	if m.Version == "" {
		return fmt.Errorf("manifest %s: version is required", m.ID)
	}
	switch m.Runtime.Kind {
	case "builtin":
	case "node", "exec":
		if m.Main == "" {
			return fmt.Errorf("manifest %s: main is required for runtime.kind=%s", m.ID, m.Runtime.Kind)
		}
	default:
		return fmt.Errorf("manifest %s: unsupported runtime.kind %q", m.ID, m.Runtime.Kind)
	}
	seen := map[string]bool{}
	for _, c := range m.Contributes.Commands {
		if !strings.HasPrefix(c.ID, m.commandPrefix()) {
			return fmt.Errorf("manifest %s: command id %q must be prefixed %q", m.ID, c.ID, m.commandPrefix())
		}
		if seen[c.ID] {
			return fmt.Errorf("manifest %s: duplicate command id %q", m.ID, c.ID)
		}
		seen[c.ID] = true
	}
	return nil
}

// commandPrefix is "<name>." — 插件命令按短名前缀(如 review-mesh.review)。
func (m Manifest) commandPrefix() string { return m.Name + "." }

// CommandOwner reports whether commandID belongs to this manifest and returns
// the bare handler name (without prefix).
func (m Manifest) CommandOwner(commandID string) (string, bool) {
	if rest, ok := strings.CutPrefix(commandID, m.commandPrefix()); ok {
		for _, c := range m.Contributes.Commands {
			if c.ID == commandID {
				return rest, true
			}
		}
	}
	return "", false
}

// SinkMatches reports whether the plugin subscribes to a notification type.
func (m Manifest) SinkMatches(notifType string) bool {
	for _, s := range m.Contributes.NotificationSinks {
		for _, e := range s.Events {
			if e == "*" || e == notifType {
				return true
			}
		}
	}
	return false
}

// HasPerm checks a "<domain>:<action>" grant against the declared ceiling.
func (m Manifest) HasPerm(perm string) bool {
	domain, action, _ := strings.Cut(perm, ":")
	in := func(list []string) bool {
		for _, v := range list {
			if v == action {
				return true
			}
		}
		return false
	}
	switch domain {
	case "workspace":
		return in(m.Permissions.Workspace)
	case "sessions":
		return in(m.Permissions.Sessions)
	case "agents":
		return in(m.Permissions.Agents)
	case "findings":
		return in(m.Permissions.Findings)
	case "notifications":
		return in(m.Permissions.Notifications)
	case "commands":
		return len(m.Permissions.Commands.Allow) > 0
	}
	return false
}

// CommandAllowed enforces the argv-prefix whitelist for command.exec.
func (m Manifest) CommandAllowed(argv []string) bool {
	if len(argv) == 0 {
		return false
	}
	joined := strings.Join(argv, " ")
	for _, d := range m.Permissions.Commands.Deny {
		if strings.HasPrefix(joined, d) {
			return false
		}
	}
	for _, a := range m.Permissions.Commands.Allow {
		if strings.HasPrefix(joined, a) {
			return true
		}
	}
	return false
}

// ParseManifestFile loads and validates a roam-plugin.json from dir.
func ParseManifestFile(dir string) (Manifest, error) {
	var m Manifest
	b, err := os.ReadFile(filepath.Join(dir, "roam-plugin.json"))
	if err != nil {
		return m, err
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return m, fmt.Errorf("roam-plugin.json: %w", err)
	}
	return m, m.Validate()
}
