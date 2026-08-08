package node

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
)

var errNoToken = errors.New("cluster: 未提供 enrollment token（cluster.token 为空），无法首次注册")

// creds2 是落盘的长期节点凭证（node.json）。
type creds2 struct {
	ID    string `json:"id"`
	Token string `json:"token"`
}

// loadCreds 读取长期节点凭证；不存在 / 不完整都返回 nil（视为未注册，走 enrollment）。
func loadCreds(path string) (*creds2, error) {
	if path == "" {
		return nil, nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, nil
	}
	var c creds2
	if json.Unmarshal(b, &c) != nil || c.ID == "" || c.Token == "" {
		return nil, nil
	}
	return &c, nil
}

// saveCreds 把长期节点凭证落盘（0600）。
func saveCreds(path string, c *creds2) error {
	if path == "" {
		return nil
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}

// sessionOpener 是 heartbeat 需要的最小接口（*yamux.Session 满足）。
type sessionOpener interface {
	Open() (net.Conn, error)
}
