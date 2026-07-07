package plugin

import "testing"

func sample() Manifest {
	return Manifest{
		ManifestVersion: 1,
		ID:              "acme.qc",
		Publisher:       "acme",
		Name:            "qc",
		Version:         "0.1.0",
		Runtime:         Runtime{Kind: "builtin"},
		Permissions: Perms{
			Workspace: []string{"read"},
			Commands:  CommandPerms{Allow: []string{"scripts/dev/quality/check.sh", "go test"}, Deny: []string{"go test -run TestDanger"}},
		},
		Contributes: Contribs{
			Commands:          []CommandContrib{{ID: "qc.review"}},
			NotificationSinks: []SinkContrib{{ID: "qc.sink", Events: []string{"finding.blocking"}}},
		},
	}
}

func TestValidateOK(t *testing.T) {
	if err := sample().Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestValidateRejects(t *testing.T) {
	m := sample()
	m.ID = "noPublisher"
	if err := m.Validate(); err == nil {
		t.Fatal("id without publisher accepted")
	}
	m = sample()
	m.Contributes.Commands = []CommandContrib{{ID: "other.review"}}
	if err := m.Validate(); err == nil {
		t.Fatal("foreign command prefix accepted")
	}
	m = sample()
	m.Runtime.Kind = "node" // main missing
	if err := m.Validate(); err == nil {
		t.Fatal("node runtime without main accepted")
	}
}

func TestCommandOwner(t *testing.T) {
	m := sample()
	handler, ok := m.CommandOwner("qc.review")
	if !ok || handler != "review" {
		t.Fatalf("want review/true, got %q/%v", handler, ok)
	}
	if _, ok := m.CommandOwner("qc.unknown"); ok {
		t.Fatal("undeclared command accepted")
	}
	if _, ok := m.CommandOwner("other.review"); ok {
		t.Fatal("foreign command accepted")
	}
}

func TestCommandAllowed(t *testing.T) {
	m := sample()
	if !m.CommandAllowed([]string{"go", "test", "./..."}) {
		t.Fatal("whitelisted prefix rejected")
	}
	if m.CommandAllowed([]string{"rm", "-rf", "/"}) {
		t.Fatal("non-whitelisted command accepted")
	}
	if m.CommandAllowed([]string{"go", "test", "-run", "TestDanger"}) {
		t.Fatal("deny rule ignored")
	}
}

func TestSinkMatches(t *testing.T) {
	m := sample()
	if !m.SinkMatches("finding.blocking") || m.SinkMatches("other.type") {
		t.Fatal("sink matching wrong")
	}
	m.Contributes.NotificationSinks[0].Events = []string{"*"}
	if !m.SinkMatches("anything") {
		t.Fatal("wildcard sink not matching")
	}
}

func TestHasPerm(t *testing.T) {
	m := sample()
	if !m.HasPerm("workspace:read") {
		t.Fatal("declared perm rejected")
	}
	if m.HasPerm("workspace:write") || m.HasPerm("agents:spawn") {
		t.Fatal("undeclared perm accepted")
	}
}
