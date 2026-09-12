package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLoadRuntimeStateLoadsRuntimeSession(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime-state.json")
	if err := os.WriteFile(path, []byte(`{"runtimes":{"agent-1":{"agentId":"agent-1","runtimeType":"CODEX","runtimeGeneration":1,"runtimeSessionId":"session-1"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	state, err := loadRuntimeState(path)
	if err != nil {
		t.Fatal(err)
	}
	record := state.Runtimes["agent-1"]
	if record.RuntimeType != "CODEX" || record.RuntimeSessionID != "session-1" {
		t.Fatalf("runtime state was not loaded: %+v", record)
	}
}

func TestLoadRuntimeStateDefaultsMissingRuntimeTypeToCodex(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime-state.json")
	if err := os.WriteFile(path, []byte(`{"runtimes":{"agent-1":{"agentId":"agent-1","runtimeGeneration":1,"runtimeSessionId":"session-1"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	state, err := loadRuntimeState(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := state.Runtimes["agent-1"].RuntimeType; got != "CODEX" {
		t.Fatalf("expected CODEX runtime default, got %q", got)
	}
}

func TestRequireSecureServerURL(t *testing.T) {
	for _, value := range []string{"https://agenticform.example.com", "http://localhost:8080", "http://127.0.0.1:8080"} {
		if err := requireSecureServerURL(value); err != nil {
			t.Fatalf("expected %q to be accepted: %v", value, err)
		}
	}
	for _, value := range []string{"http://agenticform.example.com", "ftp://agenticform.example.com", "not-a-url"} {
		if err := requireSecureServerURL(value); err == nil {
			t.Fatalf("expected %q to be rejected", value)
		}
	}
}

func TestValidateRepositoryURL(t *testing.T) {
	if err := validateRepositoryURL("https://github.com/raufimusaddiq/agenticform.git"); err != nil {
		t.Fatalf("expected public HTTPS repository to pass: %v", err)
	}
	for _, value := range []string{
		"http://github.com/raufimusaddiq/agenticform.git",
		"https://token@github.com/raufimusaddiq/agenticform.git",
		"https://github.com/raufimusaddiq/agenticform.git?token=secret",
		"ssh://git@github.com/raufimusaddiq/agenticform.git",
	} {
		if err := validateRepositoryURL(value); err == nil {
			t.Fatalf("expected credential/insecure repository %q to be rejected", value)
		}
	}
}

func TestSafeSegmentStripsPathTraversalCharacters(t *testing.T) {
	got := safeSegment("../../agent / reviewer")
	if got == "" || got == "../.." || got == "../../agent/reviewer" {
		t.Fatalf("unexpected safe segment %q", got)
	}
	for _, forbidden := range []string{"/", "\\"} {
		for _, r := range got {
			if string(r) == forbidden {
				t.Fatalf("safe segment contains path separator: %q", got)
			}
		}
	}
}

func TestDurableCommandCachesTerminalFailure(t *testing.T) {
	d := daemonRuntime{
		stateDir: t.TempDir(),
		ledger:   commandLedger{Entries: map[string]commandLedgerEntry{}},
		runtimes: runtimeState{Runtimes: map[string]runtimeRecord{}},
	}
	command := nodeCommand{
		ID:                "cmd-1",
		AgentID:           "agent-1",
		RuntimeGeneration: 1,
		CommandType:       "UNSUPPORTED",
		IdempotencyKey:    "test:1",
		PayloadJSON:       `{"runtimeGeneration":1,"runtimeType":"CODEX"}`,
	}

	_, firstErr := d.executeDurable(command)
	if firstErr == nil || !strings.Contains(firstErr.Error(), "unsupported node command") {
		t.Fatalf("expected first execution to fail as unsupported, got %v", firstErr)
	}
	first := d.ledger.Entries[command.ID]
	if first.State != "FAILED" || first.Error == "" {
		t.Fatalf("expected terminal failed ledger entry, got %+v", first)
	}

	time.Sleep(time.Millisecond)
	_, secondErr := d.executeDurable(command)
	if secondErr == nil || secondErr.Error() != first.Error {
		t.Fatalf("expected cached terminal failure %q, got %v", first.Error, secondErr)
	}
	second := d.ledger.Entries[command.ID]
	if !second.UpdatedAt.Equal(first.UpdatedAt) {
		t.Fatalf("cached replay unexpectedly rewrote ledger timestamp: first=%s second=%s", first.UpdatedAt, second.UpdatedAt)
	}
}

func TestDurableCommandRefusesAmbiguousStartedReplay(t *testing.T) {
	command := nodeCommand{
		ID:                "cmd-started",
		AgentID:           "agent-1",
		RuntimeGeneration: 3,
		CommandType:       "DISPATCH_TASK",
		IdempotencyKey:    "dispatch:1",
		PayloadJSON:       `{"runtimeGeneration":3,"runtimeType":"CODEX","runtimeSessionId":"session-1","prompt":"do work"}`,
	}
	d := daemonRuntime{
		stateDir: t.TempDir(),
		ledger: commandLedger{Entries: map[string]commandLedgerEntry{
			command.ID: {
				CommandID: command.ID, Fingerprint: commandFingerprint(command),
				State: "STARTED", UpdatedAt: time.Now().UTC(),
			},
		}},
		runtimes: runtimeState{Runtimes: map[string]runtimeRecord{}},
	}

	_, err := d.executeDurable(command)
	if err == nil || !strings.Contains(err.Error(), "refusing unsafe replay") {
		t.Fatalf("expected ambiguous STARTED command to be fenced, got %v", err)
	}
	if d.ledger.Entries[command.ID].State != "STARTED" {
		t.Fatalf("ambiguous command fence was overwritten")
	}
}

func TestCommandRejectsUnsupportedRuntimeType(t *testing.T) {
	command := nodeCommand{
		ID: "cmd-runtime", AgentID: "agent-1", RuntimeGeneration: 3,
		CommandType: "DISPATCH_TASK", IdempotencyKey: "dispatch:runtime",
		PayloadJSON: `{"runtimeGeneration":3,"runtimeType":"CLAUDE","runtimeSessionId":"session-1","prompt":"do work"}`,
	}
	d := daemonRuntime{stateDir: t.TempDir(), ledger: commandLedger{Entries: map[string]commandLedgerEntry{}}, runtimes: runtimeState{Runtimes: map[string]runtimeRecord{}}}

	_, err := d.execute(command)
	if err == nil || !strings.Contains(err.Error(), "unsupported runtime type") {
		t.Fatalf("expected unsupported runtime type rejection, got %v", err)
	}
}

func TestRuntimeStateRejectsOlderGeneration(t *testing.T) {
	d := daemonRuntime{
		stateDir: t.TempDir(),
		ledger:   commandLedger{Entries: map[string]commandLedgerEntry{}},
		runtimes: runtimeState{Runtimes: map[string]runtimeRecord{}},
	}
	newer := runtimeRecord{AgentID: "agent-1", RuntimeGeneration: 4, ThreadID: "thread-4", RuntimeStatus: "IDLE"}
	if err := d.putRuntime(newer); err != nil {
		t.Fatalf("put newer runtime: %v", err)
	}
	older := runtimeRecord{AgentID: "agent-1", RuntimeGeneration: 3, ThreadID: "thread-3", RuntimeStatus: "IDLE"}
	if err := d.putRuntime(older); err == nil {
		t.Fatalf("expected older runtime generation to be rejected")
	}
	got := d.runtimes.Runtimes["agent-1"]
	if got.RuntimeGeneration != 4 || got.ThreadID != "thread-4" {
		t.Fatalf("newer runtime was replaced: %+v", got)
	}
	if err := d.requireRuntime("agent-1", 3, "thread-3"); err == nil {
		t.Fatalf("expected stale generation runtime lookup to fail")
	}
	if err := d.requireRuntime("agent-1", 4, "thread-4"); err != nil {
		t.Fatalf("expected current generation runtime lookup to pass: %v", err)
	}
}

func TestCredentialHelperCommandIsGenerationScopedAndQuoted(t *testing.T) {
	got := credentialHelperCommand("agent';echo bad", 7, "project-1", "https://github.com/acme/private.git")
	for _, expected := range []string{"git-credential", "'7'", "'project-1'", "'https://github.com/acme/private.git'", "'\\''"} {
		if !strings.Contains(got, expected) {
			t.Fatalf("credential helper command %q missing %q", got, expected)
		}
	}
	if strings.Contains(got, "x-access-token") || strings.Contains(got, "password=") {
		t.Fatalf("credential helper command must not embed credentials: %q", got)
	}
}

func TestCleanupRefusesSharedProjectWorkspace(t *testing.T) {
	stateDir := t.TempDir()
	repo := filepath.Join(stateDir, "repos", "demo")
	d := daemonRuntime{
		stateDir: stateDir,
		runtimes: runtimeState{Runtimes: map[string]runtimeRecord{
			"agent-1": {
				AgentID: "agent-1", RuntimeGeneration: 2, ThreadID: "thread-2",
				SourceDirectory: repo, WorkingDirectory: repo, Branch: "main", RuntimeStatus: "IDLE",
			},
		}},
	}
	command := nodeCommand{AgentID: "agent-1", RuntimeGeneration: 2}

	_, err := d.cleanupWorkspace(command, map[string]any{"runtimeSessionId": "thread-2", "defaultBranch": "main"})
	if err == nil || !strings.Contains(err.Error(), "shared project workspace") {
		t.Fatalf("expected shared workspace cleanup to be refused, got %v", err)
	}
}

func TestCleanupRefusesWorkspaceOutsideManagedRoot(t *testing.T) {
	stateDir := t.TempDir()
	d := daemonRuntime{
		stateDir: stateDir,
		runtimes: runtimeState{Runtimes: map[string]runtimeRecord{
			"agent-1": {
				AgentID: "agent-1", RuntimeGeneration: 5, ThreadID: "thread-5",
				SourceDirectory:  filepath.Join(stateDir, "repos", "demo"),
				WorkingDirectory: filepath.Join(t.TempDir(), "foreign-worktree"),
				Branch:           "agent/work", RuntimeStatus: "IDLE",
			},
		}},
	}
	command := nodeCommand{AgentID: "agent-1", RuntimeGeneration: 5}

	_, err := d.cleanupWorkspace(command, map[string]any{"runtimeSessionId": "thread-5", "defaultBranch": "main"})
	if err == nil || !strings.Contains(err.Error(), "outside the managed worktree root") {
		t.Fatalf("expected unmanaged path cleanup to be refused, got %v", err)
	}
}
