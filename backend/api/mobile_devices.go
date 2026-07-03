package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

type MobileDeviceStore struct {
	file string
	mu   sync.Mutex
}

type MobileDevice struct {
	ID              string `json:"id"`
	Platform        string `json:"platform"`
	ExpoPushToken   string `json:"expoPushToken,omitempty"`
	NativePushToken string `json:"nativePushToken,omitempty"`
	AppVersion      string `json:"appVersion,omitempty"`
	UpdatedAt       string `json:"updatedAt"`
}

func NewMobileDeviceStore(dataDir string) *MobileDeviceStore {
	_ = os.MkdirAll(dataDir, 0o755)
	return &MobileDeviceStore{file: filepath.Join(dataDir, "mobile-devices.json")}
}

func (s *MobileDeviceStore) listLocked() []MobileDevice {
	var devices []MobileDevice
	if b, err := os.ReadFile(s.file); err == nil {
		_ = json.Unmarshal(b, &devices)
	}
	if devices == nil {
		devices = []MobileDevice{}
	}
	return devices
}

func (s *MobileDeviceStore) writeLocked(devices []MobileDevice) error {
	b, _ := json.MarshalIndent(devices, "", "  ")
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

func (s *MobileDeviceStore) list() []MobileDevice {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.listLocked()
}

func (s *MobileDeviceStore) upsert(d MobileDevice) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	devices := s.listLocked()
	d.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	replaced := false
	for i := range devices {
		if devices[i].ID == d.ID {
			devices[i] = d
			replaced = true
			break
		}
	}
	if !replaced {
		devices = append(devices, d)
	}
	return s.writeLocked(devices)
}

func (s *MobileDeviceStore) delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	devices := s.listLocked()
	next := devices[:0]
	for _, d := range devices {
		if d.ID != id {
			next = append(next, d)
		}
	}
	return s.writeLocked(next)
}

func (a *API) MobileDevices(c *gin.Context) {
	if a.MobileDevicesStore == nil {
		c.JSON(http.StatusOK, gin.H{"data": []MobileDevice{}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": a.MobileDevicesStore.list()})
}

func (a *API) RegisterMobileDevice(c *gin.Context) {
	if a.MobileDevicesStore == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "NO_STORE"}})
		return
	}
	var d MobileDevice
	if err := c.ShouldBindJSON(&d); err != nil || d.ID == "" || d.Platform == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	if err := a.MobileDevicesStore.upsert(d); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "WRITE_ERROR", "message": err.Error()}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
}

func (a *API) DeleteMobileDevice(c *gin.Context) {
	if a.MobileDevicesStore == nil {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
		return
	}
	if err := a.MobileDevicesStore.delete(c.Param("id")); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "WRITE_ERROR", "message": err.Error()}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
}
