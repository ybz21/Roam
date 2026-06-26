package api

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"github.com/gin-gonic/gin"
)

type PreferencesStore struct {
	file string
	mu   sync.Mutex
}

func NewPreferencesStore(dataDir string) *PreferencesStore {
	_ = os.MkdirAll(dataDir, 0o755)
	return &PreferencesStore{file: filepath.Join(dataDir, "preferences.json")}
}

func (s *PreferencesStore) get() map[string]interface{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	var p map[string]interface{}
	if b, err := os.ReadFile(s.file); err == nil {
		_ = json.Unmarshal(b, &p)
	}
	if p == nil {
		p = map[string]interface{}{}
	}
	return p
}

func (s *PreferencesStore) set(raw json.RawMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var m map[string]interface{}
	if err := json.Unmarshal(raw, &m); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(m, "", "  ")
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

func (a *API) GetPreferences(c *gin.Context) {
	if a.Prefs == nil {
		c.JSON(http.StatusOK, gin.H{"data": map[string]interface{}{}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": a.Prefs.get()})
}

func (a *API) SetPreferences(c *gin.Context) {
	if a.Prefs == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "NO_STORE"}})
		return
	}
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	if err := a.Prefs.set(raw); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "WRITE_ERROR", "message": err.Error()}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
}
