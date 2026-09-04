package api

import "testing"

func TestSummarizeChecks(t *testing.T) {
	cases := []struct {
		name string
		in   []ghCheck
		want string
	}{
		{"empty", nil, "none"},
		{"all completed success", []ghCheck{{Status: "COMPLETED", Conclusion: "SUCCESS"}, {State: "SUCCESS"}}, "passing"},
		{"one failure wins", []ghCheck{{Status: "COMPLETED", Conclusion: "SUCCESS"}, {Status: "COMPLETED", Conclusion: "FAILURE"}}, "failing"},
		{"status context failure", []ghCheck{{State: "FAILURE"}}, "failing"},
		{"in progress", []ghCheck{{Status: "IN_PROGRESS"}, {Status: "COMPLETED", Conclusion: "SUCCESS"}}, "pending"},
		{"pending context", []ghCheck{{State: "PENDING"}}, "pending"},
		{"skipped counts as passing", []ghCheck{{Status: "COMPLETED", Conclusion: "SKIPPED"}, {Status: "COMPLETED", Conclusion: "NEUTRAL"}}, "passing"},
	}
	for _, c := range cases {
		if got := summarizeChecks(c.in); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}
