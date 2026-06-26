package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"github.com/gin-gonic/gin"
)

type Preferences struct {
	Theme          string          `json:"theme"`
	Locale         string          `json:"locale"`
	BrowserQuality string          `json:"browserQuality"`
	BrowserDevice  string          `json:"browserDevice"`
	BrowserRotate  string          `json:"browserRotate"`
	PromptPopupOff map[string]bool `json:"promptPopupOff"`
	RecentDirs     []string        `json:"recentDirs"`
	ClaudeCommand  string          `json:"claudeCommand"`
	CodexCommand   string          `json:"codexCommand"`
	Migrated       bool            `json:"_migrated"`
}

type PreferencesStore struct {
	file string
	mu   sync.Mutex
}

func NewPreferencesStore(dataDir string) *PreferencesStore {
	_ = os.MkdirAll(dataDir, 0o755)
	return &PreferencesStore{file: filepath.Join(dataDir, "preferences.json")}
}

func (s *PreferencesStore) get() Preferences {
	s.mu.Lock()
	defer s.mu.Unlock()
	var p Preferences
	if b, err := os.ReadFile(s.file); err == nil {
		_ = json.Unmarshal(b, &p)
	}
	return p
}

func (s *PreferencesStore) set(p Preferences) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, _ := json.MarshalIndent(p, "", "  ")
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

func (a *API) GetPreferences(c *gin.Context) {
	if a.Prefs == nil {
		c.JSON(http.StatusOK, gin.H{"data": Preferences{}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": a.Prefs.get()})
}

func (a *API) SetPreferences(c *gin.Context) {
	if a.Prefs == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "NO_STORE"}})
		return
	}
	var in Preferences
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	if err := a.Prefs.set(in); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "WRITE_ERROR", "message": err.Error()}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
}
