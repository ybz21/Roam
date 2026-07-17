package auth

import (
	"context"
	"net/http"
)

// 隧道内部主体（typed transport principal）。
//
// 横向扩展里，浏览器的请求经云端 Broker 校验用户会话后，通过已完成节点认证的隧道
// 投递到标准节点。节点侧不能再要求浏览器的登录 Cookie（那是 Broker 签发的、节点不认），
// 但也**绝不能**用某个可由客户端伪造的 HTTP header 来放行——否则公网/局域网都能伪造。
//
// 做法：节点在从隧道 Accept 到请求、交给业务 Handler 之前，用 WithInternal 在**进程内**
// 的 request context 上打一个私有标记。context 值无法经 HTTP 线缆伪造，只有本进程里
// “已从可信隧道取出该请求”的代码路径才能设置它。Middleware 见到该标记即放行。
// 见 docs/design/cluster/客户端-服务端横向扩展设计.md §6。
type internalKey struct{}

// WithInternal 标记该请求来自已认证隧道（仅限进程内调用，不可经线缆伪造）。
func WithInternal(r *http.Request) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), internalKey{}, true))
}

// IsInternal 判断请求是否来自已认证隧道。
func IsInternal(r *http.Request) bool {
	if r == nil {
		return false
	}
	v, _ := r.Context().Value(internalKey{}).(bool)
	return v
}
