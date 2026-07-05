// Package feishu is the builtin 飞书机器人插件 case(设计见
// docs/design/plugin/03-stories.md 故事三):作为 notification sink,把 Roam
// 通知渲染成飞书卡片推送到群自定义机器人 webhook(支持加签)。
//
// v0 为出站方向;入站(@ 机器人派活)依赖飞书长连接与 intent 链,见路线图
// 阶段 3。群自定义机器人只需要 webhook URL,无需公网入口与 app 凭据,是
// 开发机场景下最低摩擦的接入方式。
package feishu

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"ttmux-cli-go/internal/plugin/sdk"
)

// Activate registers commands + the notification sink handler.
func Activate(ctx *sdk.Ctx) sdk.Plugin {
	return sdk.Plugin{
		Commands: map[string]sdk.CommandHandler{
			"test": test,
		},
		Events: map[string]sdk.EventHandler{
			"notification": onNotification,
		},
	}
}

func test(ctx *sdk.Ctx, args map[string]string) (any, error) {
	title := args["title"]
	if title == "" {
		title = "Roam 测试消息"
	}
	err := sendCard(ctx, card{
		Title:    title,
		Severity: "info",
		Body:     "这是一条来自 roam.feishu-bridge 插件的测试卡片。\n发送时间: " + time.Now().Format("2006-01-02 15:04:05"),
		Source:   "feishu-bridge.test",
	})
	if err != nil {
		return nil, err
	}
	return map[string]string{"sent": "ok"}, nil
}

func onNotification(ctx *sdk.Ctx, payload json.RawMessage) error {
	if ctx.Config["webhook"] == "" {
		// 未配置即静默跳过:sink 不该因为没接飞书就给每条通知刷错误日志
		// (feishu-bridge.test 仍显式报错,引导配置)
		ctx.Logf("webhook not configured; notification skipped")
		return nil
	}
	var n struct {
		Type     string `json:"type"`
		Severity string `json:"severity"`
		Title    string `json:"title"`
		Body     string `json:"body"`
		Source   string `json:"source"`
	}
	if err := json.Unmarshal(payload, &n); err != nil {
		return err
	}
	return sendCard(ctx, card{
		Title:    n.Title,
		Severity: n.Severity,
		Body:     n.Body,
		Source:   fmt.Sprintf("%s · %s", n.Source, n.Type),
	})
}

type card struct {
	Title    string
	Severity string
	Body     string
	Source   string
}

// sendCard posts an interactive card to the configured group-bot webhook.
func sendCard(ctx *sdk.Ctx, c card) error {
	webhook := ctx.Config["webhook"]
	if webhook == "" {
		ctx.Logf("webhook not configured; skip (set with: ttmux plugin config feishu-bridge set webhook <url>)")
		return fmt.Errorf("feishu webhook not configured: ttmux plugin config feishu-bridge set webhook <url>")
	}
	template := map[string]string{"high": "red", "warning": "orange", "info": "blue"}[c.Severity]
	if template == "" {
		template = "blue"
	}
	body := c.Body
	if body == "" {
		body = "(无正文)"
	}
	msg := map[string]any{
		"msg_type": "interactive",
		"card": map[string]any{
			"header": map[string]any{
				"title":    map[string]any{"tag": "plain_text", "content": c.Title},
				"template": template,
			},
			"elements": []any{
				map[string]any{"tag": "markdown", "content": body},
				map[string]any{"tag": "note", "elements": []any{
					map[string]any{"tag": "plain_text", "content": "Roam · " + c.Source},
				}},
			},
		},
	}
	if secret := ctx.Config["secret"]; secret != "" {
		ts := fmt.Sprintf("%d", time.Now().Unix())
		msg["timestamp"] = ts
		msg["sign"] = sign(ts, secret)
	}
	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Post(webhook, "application/json", bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("feishu webhook post failed: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	var result struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	_ = json.Unmarshal(respBody, &result)
	if resp.StatusCode != 200 || result.Code != 0 {
		return fmt.Errorf("feishu webhook rejected (http=%d code=%d): %s", resp.StatusCode, result.Code, strings.TrimSpace(result.Msg))
	}
	ctx.Logf("card sent: %s", c.Title)
	return nil
}

// sign implements 飞书自定义机器人加签: HmacSHA256(key=timestamp+"\n"+secret,
// data="") 后 base64。
func sign(timestamp, secret string) string {
	key := timestamp + "\n" + secret
	mac := hmac.New(sha256.New, []byte(key))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}
