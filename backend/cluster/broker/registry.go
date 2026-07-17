// Package broker 是云端 Broker 的数据面 + 控制面：节点注册表、enrollment 签发、
// 隧道服务端、以及把带 nodeId 的前端请求反代进目标节点隧道。它只做路由 + 注册，
// 不重实现任何业务能力。见 docs/design/cluster/客户端-服务端横向扩展设计.md §2.3 / §7。
package broker

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/hashicorp/yamux"
)

// heartbeatTimeout 超过这个时长没收到心跳即判该节点离线（前端灰显）。
const heartbeatTimeout = 30 * time.Second

// Node 是注册表里一条节点记录。凭证本身不明文入库，只存 token 的哈希。
type Node struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Hostname      string    `json:"hostname"`
	OS            string    `json:"os"`
	Version       string    `json:"version"`
	Capabilities  []string  `json:"capabilities"`
	Group         string    `json:"group"`
	Tags          []string  `json:"tags,omitempty"`
	SessionCount  int       `json:"sessionCount"`
	Load          float64   `json:"load"`
	LastHeartbeat time.Time `json:"lastHeartbeat"`
	TokenHash     string    `json:"tokenHash"` // sha256(nodeToken)，用于重连鉴权
}

// Online 依据最后心跳时间判活。
func (n *Node) Online() bool { return time.Since(n.LastHeartbeat) < heartbeatTimeout }

// enrollment 是一次性接入令牌。
type enrollment struct {
	Token     string
	ExpiresAt time.Time
	Used      bool
	Name      string
	Group     string
}

// Registry 维护节点元数据（落盘）、在线隧道会话（内存）与 enrollment 令牌（内存）。
type Registry struct {
	mu       sync.RWMutex
	nodes    map[string]*Node
	sessions map[string]*yamux.Session // nodeId -> 当前在线隧道
	enroll   map[string]*enrollment
	path     string // nodes.json 落盘路径
}

// NewRegistry 从 dir/nodes.json 加载已知节点（缺失则空）。
func NewRegistry(dir string) *Registry {
	r := &Registry{
		nodes:    map[string]*Node{},
		sessions: map[string]*yamux.Session{},
		enroll:   map[string]*enrollment{},
		path:     filepath.Join(dir, "nodes.json"),
	}
	if b, err := os.ReadFile(r.path); err == nil {
		var list []*Node
		if json.Unmarshal(b, &list) == nil {
			for _, n := range list {
				r.nodes[n.ID] = n
			}
		}
	}
	return r
}

func (r *Registry) persistLocked() {
	list := make([]*Node, 0, len(r.nodes))
	for _, n := range r.nodes {
		list = append(list, n)
	}
	b, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(r.path), 0o700)
	_ = os.WriteFile(r.path, b, 0o600)
}

// CreateEnrollment 生成一次性接入令牌（默认 30 分钟过期）。
func (r *Registry) CreateEnrollment(name, group string, ttl time.Duration) *enrollment {
	if ttl <= 0 {
		ttl = 30 * time.Minute
	}
	e := &enrollment{Token: randToken(), ExpiresAt: time.Now().Add(ttl), Name: name, Group: group}
	r.mu.Lock()
	r.enroll[e.Token] = e
	r.mu.Unlock()
	return e
}

// ConsumeEnrollment 校验并消费接入令牌，创建/复用节点并换发长期节点凭证。
// 返回 nodeID、明文 nodeToken（仅此一次返回，之后只存哈希）。
func (r *Registry) ConsumeEnrollment(token, name, group string, meta NodeMeta) (id, nodeToken string, ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.enroll[token]
	if e == nil || e.Used || time.Now().After(e.ExpiresAt) {
		return "", "", false
	}
	e.Used = true
	id = "n_" + randID()
	nodeToken = randToken()
	if name == "" {
		name = firstNonEmpty(e.Name, meta.Hostname, id)
	}
	if group == "" {
		group = e.Group
	}
	r.nodes[id] = &Node{
		ID: id, Name: name, Group: group,
		Hostname: meta.Hostname, OS: meta.OS, Version: meta.Version, Capabilities: meta.Capabilities,
		TokenHash: hashToken(nodeToken), LastHeartbeat: time.Now(),
	}
	r.persistLocked()
	return id, nodeToken, true
}

// AuthNode 校验已注册节点的长期凭证（重连时用）。
func (r *Registry) AuthNode(id, token string) bool {
	r.mu.RLock()
	n := r.nodes[id]
	r.mu.RUnlock()
	if n == nil || n.TokenHash == "" {
		return false
	}
	want, _ := hex.DecodeString(n.TokenHash)
	got := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(want, got[:]) == 1
}

// Attach 绑定一条在线隧道会话；同一节点已有旧会话则关闭它。
func (r *Registry) Attach(id string, sess *yamux.Session, meta NodeMeta) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if old := r.sessions[id]; old != nil {
		_ = old.Close()
	}
	r.sessions[id] = sess
	if n := r.nodes[id]; n != nil {
		n.LastHeartbeat = time.Now()
		if meta.Hostname != "" {
			n.Hostname, n.OS, n.Version, n.Capabilities = meta.Hostname, meta.OS, meta.Version, meta.Capabilities
		}
		r.persistLocked()
	}
}

// Detach 解绑会话（隧道断开时）。
func (r *Registry) Detach(id string, sess *yamux.Session) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sessions[id] == sess {
		delete(r.sessions, id)
	}
}

// Heartbeat 更新节点的心跳时间与上报的会话数 / 负载。
func (r *Registry) Heartbeat(id string, sessionCount int, load float64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if n := r.nodes[id]; n != nil {
		n.LastHeartbeat = time.Now()
		n.SessionCount = sessionCount
		n.Load = load
	}
}

// Session 返回节点当前在线隧道会话（不在线返回 nil）。
func (r *Registry) Session(id string) *yamux.Session {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.sessions[id]
}

// List 返回节点快照（含在线状态）。
func (r *Registry) List() []NodeView {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]NodeView, 0, len(r.nodes))
	for _, n := range r.nodes {
		_, online := r.sessions[n.ID]
		out = append(out, NodeView{Node: *n, Online: online && n.Online()})
	}
	return out
}

// NodeMeta 是节点接入 / 心跳时上报的自身信息。
type NodeMeta struct {
	Hostname     string   `json:"hostname"`
	OS           string   `json:"os"`
	Version      string   `json:"version"`
	Capabilities []string `json:"capabilities"`
}

// NodeView 是给前端的节点视图（元数据 + 实时在线状态）。
type NodeView struct {
	Node
	Online bool `json:"online"`
}

func randToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func randID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func hashToken(t string) string {
	sum := sha256.Sum256([]byte(t))
	return hex.EncodeToString(sum[:])
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
