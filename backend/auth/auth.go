// Package auth 负责口令校验、token 签发/校验、防爆破与认证中间件。
//
// 当前为单用户：口令来自配置（明文比较，常量时间）。argon2 哈希 +
// passwd 子命令 + TOTP/Passkey 为后续增强（见 docs/web/03-auth-security.md）。
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const CookieName = "ttmux_session"

type Auth struct {
	password  string
	secret    []byte
	lockAfter int
	lockSecs  int
	ttl       time.Duration

	mu          sync.Mutex
	fails       int
	lockedUntil time.Time
}

func New(password string, lockAfter, lockSecs int) *Auth {
	return &Auth{
		password:  password,
		secret:    randBytes(32),
		lockAfter: lockAfter,
		lockSecs:  lockSecs,
		ttl:       7 * 24 * time.Hour,
	}
}

func randBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return []byte(time.Now().String())
	}
	return b
}

func (a *Auth) hmacHex(msg string) string {
	m := hmac.New(sha256.New, a.secret)
	m.Write([]byte(msg))
	return hex.EncodeToString(m.Sum(nil))
}

func (a *Auth) issue() string {
	exp := time.Now().Add(a.ttl).Unix()
	msg := fmt.Sprintf("%d.%s", exp, hex.EncodeToString(randBytes(8)))
	return msg + "." + a.hmacHex(msg)
}

func (a *Auth) verify(tok string) bool {
	p := strings.Split(tok, ".")
	if len(p) != 3 {
		return false
	}
	msg := p[0] + "." + p[1]
	if !hmac.Equal([]byte(a.hmacHex(msg)), []byte(p[2])) {
		return false
	}
	exp, err := strconv.ParseInt(p[0], 10, 64)
	return err == nil && time.Now().Unix() < exp
}

// Middleware 校验签名 Cookie；失败返回 401。
func (a *Auth) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		tok, err := c.Cookie(CookieName)
		if err != nil || !a.verify(tok) {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": gin.H{"code": "UNAUTHORIZED"}})
			return
		}
		c.Next()
	}
}

func (a *Auth) Login(c *gin.Context) {
	a.mu.Lock()
	locked := time.Now().Before(a.lockedUntil)
	a.mu.Unlock()
	if locked {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": gin.H{"code": "LOCKED", "message": "登录已锁定，请稍后再试"}})
		return
	}

	var body struct {
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}

	if subtle.ConstantTimeCompare([]byte(body.Password), []byte(a.password)) != 1 {
		a.mu.Lock()
		a.fails++
		fails := a.fails
		if a.fails >= a.lockAfter {
			a.lockedUntil = time.Now().Add(time.Duration(a.lockSecs) * time.Second)
			a.fails = 0
		}
		a.mu.Unlock()
		backoff := fails
		if backoff > 3 {
			backoff = 3
		}
		time.Sleep(time.Duration(backoff) * 300 * time.Millisecond)
		c.JSON(http.StatusUnauthorized, gin.H{"error": gin.H{"code": "BAD_PASSWORD", "remaining": a.lockAfter - fails}})
		return
	}

	a.mu.Lock()
	a.fails = 0
	a.mu.Unlock()

	// Secure 仅在 HTTPS 下设置（本地 http 时关闭，否则 cookie 不生效）
	secure := c.Request.TLS != nil || strings.HasPrefix(strings.ToLower(c.GetHeader("X-Forwarded-Proto")), "https")
	c.SetSameSite(http.SameSiteStrictMode)
	c.SetCookie(CookieName, a.issue(), int(a.ttl.Seconds()), "/", "", secure, true)
	c.JSON(http.StatusOK, gin.H{"data": "ok"})
}

func (a *Auth) Logout(c *gin.Context) {
	c.SetCookie(CookieName, "", -1, "/", "", false, true)
	c.JSON(http.StatusOK, gin.H{"data": "ok"})
}
