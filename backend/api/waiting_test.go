package api

import "testing"

func TestSessionWaitingRejectsAgentCommandList(t *testing.T) {
	capture := `Running implementation work…
  1. Run the formatter command
  2. Continue with the typecheck
  3. Write the result > report.txt
Working…`
	if sessionWaiting(capture) {
		t.Fatal("normal agent command list must not be treated as waiting for confirmation")
	}
}

func TestSessionWaitingRejectsQuotedListAndHistoricalYesNo(t *testing.T) {
	capture := `Documentation example:
> 1. Run the command
> 2. Continue editing
Answer prompts with (y/n).
Done.`
	if sessionWaiting(capture) {
		t.Fatal("quoted list or historical y/n text must not be treated as a current prompt")
	}
}

func TestSessionWaitingAcceptsCursorMenu(t *testing.T) {
	capture := `Select model
  1. Default
❯ 2. Opus
  3. Fable
Enter to select · Esc to cancel`
	if !sessionWaiting(capture) {
		t.Fatal("menu with an option cursor must be treated as waiting for confirmation")
	}
}

func TestSessionWaitingAcceptsExplicitPromptWithoutCursor(t *testing.T) {
	capture := `Are you sure you want to proceed?
  1. Yes, continue
  2. No, go back
Enter to confirm · Esc to cancel`
	if !sessionWaiting(capture) {
		t.Fatal("explicit question with action hints must be treated as waiting for confirmation")
	}
}
