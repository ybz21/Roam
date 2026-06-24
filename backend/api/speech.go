// 语音识别(ASR)：接收前端录音(WAV)，转发到所配置的服务商并返回识别文本。
// 支持 OpenAI(Whisper/transcriptions 兼容接口) 与 火山引擎(大模型录音识别·极速版)。
// 服务商密钥持久化到 <dataDir>/speech-config.json，单独管理，不走 env(避免被 push 进 shell 会话)。
package api

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// 单个会话录音的体积上限(WAV 16k 单声道约 32KB/s，25MB 足够长语音)。
const speechMaxBytes = 25 << 20

type OpenAISpeech struct {
	BaseURL  string `json:"baseURL"`  // 默认 https://api.openai.com/v1
	APIKey   string `json:"apiKey"`   //
	Model    string `json:"model"`    // 默认 whisper-1
	Language string `json:"language"` // 可空：如 zh / en，留空自动检测
}

type VolcanoSpeech struct {
	AppID       string `json:"appId"`       // 火山控制台 App ID
	AccessToken string `json:"accessToken"` // 火山控制台 Access Token
	ResourceID  string `json:"resourceId"`  // 默认 volc.bigasr.auc_turbo(大模型极速版)
	Endpoint    string `json:"endpoint"`    // 默认极速版 flash 接口
}

type SpeechConfig struct {
	Provider string        `json:"provider"` // "openai" | "volcano" | ""(未配置)
	OpenAI   OpenAISpeech  `json:"openai"`
	Volcano  VolcanoSpeech `json:"volcano"`
}

// SpeechStore 持久化 ASR 配置，原子写回。
type SpeechStore struct {
	file string
	mu   sync.Mutex
}

func NewSpeechStore(dataDir string) *SpeechStore {
	_ = os.MkdirAll(dataDir, 0o755)
	return &SpeechStore{file: filepath.Join(dataDir, "speech-config.json")}
}

func (s *SpeechStore) get() SpeechConfig {
	s.mu.Lock()
	defer s.mu.Unlock()
	var c SpeechConfig
	if b, err := os.ReadFile(s.file); err == nil {
		_ = json.Unmarshal(b, &c)
	}
	return c
}

func (s *SpeechStore) set(c SpeechConfig) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, _ := json.MarshalIndent(c, "", "  ")
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

// GetSpeechConfig 返回当前 ASR 配置(含密钥；本工具单用户自托管，与 env 页一致地明文回显)。
func (a *API) GetSpeechConfig(c *gin.Context) {
	if a.Speech == nil {
		c.JSON(http.StatusOK, gin.H{"data": SpeechConfig{}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": a.Speech.get()})
}

// SetSpeechConfig 整体覆盖保存 ASR 配置。
func (a *API) SetSpeechConfig(c *gin.Context) {
	if a.Speech == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "NO_STORE"}})
		return
	}
	var in SpeechConfig
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	if err := a.Speech.set(in); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "WRITE_ERROR", "message": err.Error()}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
}

// SpeechTranscribe 接收 multipart 字段 audio(WAV)，调所配置的服务商返回识别文本。
func (a *API) SpeechTranscribe(c *gin.Context) {
	if a.Speech == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "NO_STORE"}})
		return
	}
	cfg := a.Speech.get()
	fh, err := c.FormFile("audio")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "NO_AUDIO"}})
		return
	}
	if fh.Size > speechMaxBytes {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "AUDIO_TOO_LARGE"}})
		return
	}
	f, err := fh.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_AUDIO", "message": err.Error()}})
		return
	}
	defer f.Close()
	audio, err := io.ReadAll(io.LimitReader(f, speechMaxBytes))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_AUDIO", "message": err.Error()}})
		return
	}

	var text string
	switch cfg.Provider {
	case "openai":
		text, err = transcribeOpenAI(cfg.OpenAI, audio, fh.Filename)
	case "volcano":
		text, err = transcribeVolcano(cfg.Volcano, audio)
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "NOT_CONFIGURED"}})
		return
	}
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": gin.H{"code": "ASR_ERROR", "message": err.Error()}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"text": strings.TrimSpace(text)}})
}

// transcribeOpenAI 走 OpenAI 兼容的 /audio/transcriptions multipart 接口。
func transcribeOpenAI(cfg OpenAISpeech, audio []byte, filename string) (string, error) {
	if cfg.APIKey == "" {
		return "", fmt.Errorf("openai api key not set")
	}
	base := strings.TrimRight(cfg.BaseURL, "/")
	if base == "" {
		base = "https://api.openai.com/v1"
	}
	model := cfg.Model
	if model == "" {
		model = "whisper-1"
	}
	if filename == "" {
		filename = "audio.wav"
	}

	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fw, err := w.CreateFormFile("file", filename)
	if err != nil {
		return "", err
	}
	if _, err := fw.Write(audio); err != nil {
		return "", err
	}
	_ = w.WriteField("model", model)
	if cfg.Language != "" {
		_ = w.WriteField("language", cfg.Language)
	}
	if err := w.Close(); err != nil {
		return "", err
	}

	req, err := http.NewRequest("POST", base+"/audio/transcriptions", &buf)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	req.Header.Set("Content-Type", w.FormDataContentType())

	resp, err := (&http.Client{Timeout: 120 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("openai %d: %s", resp.StatusCode, truncate(string(body), 300))
	}
	var r struct {
		Text  string `json:"text"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return "", fmt.Errorf("parse openai resp: %w", err)
	}
	if r.Error != nil {
		return "", fmt.Errorf("openai: %s", r.Error.Message)
	}
	return r.Text, nil
}

// transcribeVolcano 走火山引擎「大模型录音识别·极速版」(v3 flash) 同步接口。
// 鉴权用请求头携带 App Key / Access Key / Resource Id；音频以 base64 放进 JSON。
func transcribeVolcano(cfg VolcanoSpeech, audio []byte) (string, error) {
	if cfg.AppID == "" || cfg.AccessToken == "" {
		return "", fmt.Errorf("volcano credentials not set")
	}
	endpoint := cfg.Endpoint
	if endpoint == "" {
		endpoint = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash"
	}
	resourceID := cfg.ResourceID
	if resourceID == "" {
		resourceID = "volc.bigasr.auc_turbo"
	}

	reqBody := map[string]any{
		"user": map[string]any{"uid": "ttmux"},
		"audio": map[string]any{
			"format": "wav",
			"data":   base64.StdEncoding.EncodeToString(audio),
		},
		"request": map[string]any{
			"model_name":  "bigmodel",
			"enable_itn":  true,
			"enable_punc": true,
		},
	}
	b, _ := json.Marshal(reqBody)
	req, err := http.NewRequest("POST", endpoint, bytes.NewReader(b))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-App-Key", cfg.AppID)
	req.Header.Set("X-Api-Access-Key", cfg.AccessToken)
	req.Header.Set("X-Api-Resource-Id", resourceID)
	req.Header.Set("X-Api-Request-Id", randomID())
	req.Header.Set("X-Api-Sequence", "-1")

	resp, err := (&http.Client{Timeout: 120 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	// 极速版的成功/失败码放在响应头(20000000 表示成功)。
	if code := resp.Header.Get("X-Api-Status-Code"); code != "" && code != "20000000" {
		msg := resp.Header.Get("X-Api-Message")
		return "", fmt.Errorf("volcano %s: %s %s", code, msg, truncate(string(body), 200))
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("volcano http %d: %s", resp.StatusCode, truncate(string(body), 300))
	}

	var r struct {
		Result struct {
			Text string `json:"text"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return "", fmt.Errorf("parse volcano resp: %w", err)
	}
	return r.Result.Text, nil
}

func randomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "ttmux-req"
	}
	return hex.EncodeToString(b[:])
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
