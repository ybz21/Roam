package api

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

type FootballPlayer struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Position    string `json:"position"`
	Age         int    `json:"age"`
	TeamID      string `json:"teamId"`
	Rating      int    `json:"rating"`
	Value       int    `json:"value"`
	Wage        int    `json:"wage"`
	Nationality string `json:"nationality"`
}

type FootballLineup struct {
	Formation string   `json:"formation"`
	Starters  []string `json:"starters"`
	Bench     []string `json:"bench"`
}

type FootballTeam struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	City      string         `json:"city"`
	Budget    int            `json:"budget"`
	PlayerIDs []string       `json:"playerIds"`
	Lineup    FootballLineup `json:"lineup"`
}

type FootballTransfer struct {
	ID         string `json:"id"`
	PlayerID   string `json:"playerId"`
	FromTeamID string `json:"fromTeamId"`
	ToTeamID   string `json:"toTeamId"`
	Fee        int    `json:"fee"`
	Wage       int    `json:"wage"`
	CreatedAt  string `json:"createdAt"`
}

type FootballStore struct {
	mu           sync.RWMutex
	players      map[string]FootballPlayer
	teams        map[string]FootballTeam
	transfers    map[string]FootballTransfer
	nextPlayer   int
	nextTeam     int
	nextTransfer int
}

func NewFootballStore() *FootballStore {
	s := &FootballStore{
		players:      map[string]FootballPlayer{},
		teams:        map[string]FootballTeam{},
		transfers:    map[string]FootballTransfer{},
		nextPlayer:   1,
		nextTeam:     1,
		nextTransfer: 1,
	}
	teamA := s.addTeamLocked(FootballTeam{Name: "Northbridge FC", City: "Northbridge", Budget: 42000000})
	teamB := s.addTeamLocked(FootballTeam{Name: "Harbor United", City: "Harbor", Budget: 36000000})
	s.addPlayerLocked(FootballPlayer{Name: "Lin Wei", Position: "ST", Age: 24, TeamID: teamA.ID, Rating: 82, Value: 18000000, Wage: 85000, Nationality: "CN"})
	s.addPlayerLocked(FootballPlayer{Name: "Marco Silva", Position: "CM", Age: 28, TeamID: teamA.ID, Rating: 79, Value: 12000000, Wage: 62000, Nationality: "PT"})
	s.addPlayerLocked(FootballPlayer{Name: "Ethan Brooks", Position: "GK", Age: 30, TeamID: teamB.ID, Rating: 77, Value: 8000000, Wage: 48000, Nationality: "EN"})
	s.addPlayerLocked(FootballPlayer{Name: "Noah Park", Position: "CB", Age: 26, TeamID: teamB.ID, Rating: 76, Value: 9000000, Wage: 52000, Nationality: "KR"})
	return s
}

func (s *FootballStore) addTeamLocked(t FootballTeam) FootballTeam {
	t.ID = s.nextID("t", s.nextTeam)
	s.nextTeam++
	if t.Lineup.Formation == "" {
		t.Lineup.Formation = "4-3-3"
	}
	t.PlayerIDs = []string{}
	s.teams[t.ID] = t
	return t
}

func (s *FootballStore) addPlayerLocked(p FootballPlayer) FootballPlayer {
	p.ID = s.nextID("p", s.nextPlayer)
	s.nextPlayer++
	s.players[p.ID] = p
	if p.TeamID != "" {
		t := s.teams[p.TeamID]
		t.PlayerIDs = appendUnique(t.PlayerIDs, p.ID)
		s.teams[p.TeamID] = t
	}
	return p
}

func (s *FootballStore) nextID(prefix string, n int) string {
	return prefix + strconv.Itoa(n)
}

func badFootballRequest(c *gin.Context, code string) {
	c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": code}})
}

func notFoundFootball(c *gin.Context, code string) {
	c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"code": code}})
}

func (a *API) FootballPlayers(c *gin.Context) {
	a.Football.mu.RLock()
	defer a.Football.mu.RUnlock()
	out := make([]FootballPlayer, 0, len(a.Football.players))
	for _, p := range a.Football.players {
		if teamID := c.Query("teamId"); teamID != "" && p.TeamID != teamID {
			continue
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	c.JSON(http.StatusOK, gin.H{"data": out})
}

func (a *API) FootballPlayer(c *gin.Context) {
	a.Football.mu.RLock()
	defer a.Football.mu.RUnlock()
	p, ok := a.Football.players[c.Param("id")]
	if !ok {
		notFoundFootball(c, "PLAYER_NOT_FOUND")
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": p})
}

func (a *API) FootballPlayerCreate(c *gin.Context) {
	var b FootballPlayer
	if err := c.ShouldBindJSON(&b); err != nil || strings.TrimSpace(b.Name) == "" {
		badFootballRequest(c, "BAD_REQUEST")
		return
	}
	a.Football.mu.Lock()
	defer a.Football.mu.Unlock()
	if b.TeamID != "" {
		if _, ok := a.Football.teams[b.TeamID]; !ok {
			badFootballRequest(c, "TEAM_NOT_FOUND")
			return
		}
	}
	p := a.Football.addPlayerLocked(b)
	c.JSON(http.StatusOK, gin.H{"data": p})
}

func (a *API) FootballPlayerPatch(c *gin.Context) {
	var b FootballPlayer
	if err := c.ShouldBindJSON(&b); err != nil {
		badFootballRequest(c, "BAD_REQUEST")
		return
	}
	a.Football.mu.Lock()
	defer a.Football.mu.Unlock()
	p, ok := a.Football.players[c.Param("id")]
	if !ok {
		notFoundFootball(c, "PLAYER_NOT_FOUND")
		return
	}
	if b.TeamID != "" {
		if _, ok := a.Football.teams[b.TeamID]; !ok {
			badFootballRequest(c, "TEAM_NOT_FOUND")
			return
		}
		if p.TeamID != b.TeamID {
			a.Football.movePlayerLocked(p.ID, p.TeamID, b.TeamID)
			p.TeamID = b.TeamID
		}
	}
	if strings.TrimSpace(b.Name) != "" {
		p.Name = b.Name
	}
	if b.Position != "" {
		p.Position = b.Position
	}
	if b.Age != 0 {
		p.Age = b.Age
	}
	if b.Rating != 0 {
		p.Rating = b.Rating
	}
	if b.Value != 0 {
		p.Value = b.Value
	}
	if b.Wage != 0 {
		p.Wage = b.Wage
	}
	if b.Nationality != "" {
		p.Nationality = b.Nationality
	}
	a.Football.players[p.ID] = p
	c.JSON(http.StatusOK, gin.H{"data": p})
}

func (a *API) FootballPlayerDelete(c *gin.Context) {
	a.Football.mu.Lock()
	defer a.Football.mu.Unlock()
	p, ok := a.Football.players[c.Param("id")]
	if !ok {
		notFoundFootball(c, "PLAYER_NOT_FOUND")
		return
	}
	delete(a.Football.players, p.ID)
	a.Football.removePlayerFromTeamLocked(p.TeamID, p.ID)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"id": p.ID}})
}

func (a *API) FootballTeams(c *gin.Context) {
	a.Football.mu.RLock()
	defer a.Football.mu.RUnlock()
	out := make([]FootballTeam, 0, len(a.Football.teams))
	for _, t := range a.Football.teams {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	c.JSON(http.StatusOK, gin.H{"data": out})
}

func (a *API) FootballTeam(c *gin.Context) {
	a.Football.mu.RLock()
	defer a.Football.mu.RUnlock()
	t, ok := a.Football.teams[c.Param("id")]
	if !ok {
		notFoundFootball(c, "TEAM_NOT_FOUND")
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"team": t, "players": a.Football.playersForTeamLocked(t.ID)}})
}

func (a *API) FootballTeamCreate(c *gin.Context) {
	var b FootballTeam
	if err := c.ShouldBindJSON(&b); err != nil || strings.TrimSpace(b.Name) == "" {
		badFootballRequest(c, "BAD_REQUEST")
		return
	}
	a.Football.mu.Lock()
	defer a.Football.mu.Unlock()
	t := a.Football.addTeamLocked(b)
	c.JSON(http.StatusOK, gin.H{"data": t})
}

func (a *API) FootballTeamPatch(c *gin.Context) {
	var b FootballTeam
	if err := c.ShouldBindJSON(&b); err != nil {
		badFootballRequest(c, "BAD_REQUEST")
		return
	}
	a.Football.mu.Lock()
	defer a.Football.mu.Unlock()
	t, ok := a.Football.teams[c.Param("id")]
	if !ok {
		notFoundFootball(c, "TEAM_NOT_FOUND")
		return
	}
	if strings.TrimSpace(b.Name) != "" {
		t.Name = b.Name
	}
	if b.City != "" {
		t.City = b.City
	}
	if b.Budget != 0 {
		t.Budget = b.Budget
	}
	a.Football.teams[t.ID] = t
	c.JSON(http.StatusOK, gin.H{"data": t})
}

func (a *API) FootballTeamDelete(c *gin.Context) {
	a.Football.mu.Lock()
	defer a.Football.mu.Unlock()
	t, ok := a.Football.teams[c.Param("id")]
	if !ok {
		notFoundFootball(c, "TEAM_NOT_FOUND")
		return
	}
	for _, pid := range t.PlayerIDs {
		p := a.Football.players[pid]
		p.TeamID = ""
		a.Football.players[pid] = p
	}
	delete(a.Football.teams, t.ID)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"id": t.ID}})
}

func (a *API) FootballTeamLineup(c *gin.Context) {
	var b FootballLineup
	if err := c.ShouldBindJSON(&b); err != nil || strings.TrimSpace(b.Formation) == "" {
		badFootballRequest(c, "BAD_REQUEST")
		return
	}
	a.Football.mu.Lock()
	defer a.Football.mu.Unlock()
	t, ok := a.Football.teams[c.Param("id")]
	if !ok {
		notFoundFootball(c, "TEAM_NOT_FOUND")
		return
	}
	if !a.Football.playersBelongToTeamLocked(t.ID, append(append([]string{}, b.Starters...), b.Bench...)) {
		badFootballRequest(c, "PLAYER_TEAM_MISMATCH")
		return
	}
	t.Lineup = b
	a.Football.teams[t.ID] = t
	c.JSON(http.StatusOK, gin.H{"data": t})
}

func (a *API) FootballTransfers(c *gin.Context) {
	a.Football.mu.RLock()
	defer a.Football.mu.RUnlock()
	out := make([]FootballTransfer, 0, len(a.Football.transfers))
	for _, t := range a.Football.transfers {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	c.JSON(http.StatusOK, gin.H{"data": out})
}

func (a *API) FootballTransferCreate(c *gin.Context) {
	var b struct {
		PlayerID string `json:"playerId"`
		ToTeamID string `json:"toTeamId"`
		Fee      int    `json:"fee"`
		Wage     int    `json:"wage"`
	}
	if err := c.ShouldBindJSON(&b); err != nil || b.PlayerID == "" || b.ToTeamID == "" {
		badFootballRequest(c, "BAD_REQUEST")
		return
	}
	a.Football.mu.Lock()
	defer a.Football.mu.Unlock()
	p, ok := a.Football.players[b.PlayerID]
	if !ok {
		notFoundFootball(c, "PLAYER_NOT_FOUND")
		return
	}
	to, ok := a.Football.teams[b.ToTeamID]
	if !ok {
		notFoundFootball(c, "TEAM_NOT_FOUND")
		return
	}
	if b.Fee > to.Budget {
		badFootballRequest(c, "INSUFFICIENT_BUDGET")
		return
	}
	tr := FootballTransfer{
		ID:       a.Football.nextID("tr", a.Football.nextTransfer),
		PlayerID: p.ID, FromTeamID: p.TeamID, ToTeamID: to.ID,
		Fee: b.Fee, Wage: b.Wage, CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	a.Football.nextTransfer++
	if from, ok := a.Football.teams[p.TeamID]; ok {
		from.Budget += b.Fee
		a.Football.teams[from.ID] = from
	}
	to.Budget -= b.Fee
	a.Football.teams[to.ID] = to
	a.Football.movePlayerLocked(p.ID, p.TeamID, to.ID)
	p.TeamID = to.ID
	if b.Wage != 0 {
		p.Wage = b.Wage
	}
	a.Football.players[p.ID] = p
	a.Football.transfers[tr.ID] = tr
	c.JSON(http.StatusOK, gin.H{"data": tr})
}

func (s *FootballStore) playersForTeamLocked(teamID string) []FootballPlayer {
	out := []FootballPlayer{}
	for _, p := range s.players {
		if p.TeamID == teamID {
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func (s *FootballStore) playersBelongToTeamLocked(teamID string, playerIDs []string) bool {
	seen := map[string]bool{}
	for _, id := range playerIDs {
		if id == "" || seen[id] {
			return false
		}
		seen[id] = true
		p, ok := s.players[id]
		if !ok || p.TeamID != teamID {
			return false
		}
	}
	return true
}

func (s *FootballStore) movePlayerLocked(playerID, fromTeamID, toTeamID string) {
	s.removePlayerFromTeamLocked(fromTeamID, playerID)
	if toTeamID != "" {
		t := s.teams[toTeamID]
		t.PlayerIDs = appendUnique(t.PlayerIDs, playerID)
		s.teams[toTeamID] = t
	}
}

func (s *FootballStore) removePlayerFromTeamLocked(teamID, playerID string) {
	if teamID == "" {
		return
	}
	t, ok := s.teams[teamID]
	if !ok {
		return
	}
	t.PlayerIDs = removeString(t.PlayerIDs, playerID)
	t.Lineup.Starters = removeString(t.Lineup.Starters, playerID)
	t.Lineup.Bench = removeString(t.Lineup.Bench, playerID)
	s.teams[teamID] = t
}

func appendUnique(xs []string, v string) []string {
	for _, x := range xs {
		if x == v {
			return xs
		}
	}
	return append(xs, v)
}

func removeString(xs []string, v string) []string {
	out := xs[:0]
	for _, x := range xs {
		if x != v {
			out = append(out, x)
		}
	}
	return out
}
