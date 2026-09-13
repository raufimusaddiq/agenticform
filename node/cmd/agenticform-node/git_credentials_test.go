package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestConfigureCredentialHelperIsWorktreeScoped(t *testing.T) {
	root := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, output)
		}
	}
	run("init", "-q")
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "test")
	if err := os.WriteFile(filepath.Join(root, "README"), []byte("test\n"), 0600); err != nil {
		t.Fatal(err)
	}
	run("add", "README")
	run("commit", "-qm", "initial")
	if err := configureCredentialHelper(root, "!agenticform-node git-credential agent-a"); err != nil {
		t.Fatal(err)
	}
	worktree := filepath.Join(root, "worktree")
	run("worktree", "add", "-q", "-b", "agent", worktree)
	if err := configureCredentialHelper(worktree, "!agenticform-node git-credential agent-b"); err != nil {
		t.Fatal(err)
	}
	config := func(directory string) string {
		output, err := exec.Command("git", "-C", directory, "config", "--get-all", "credential.helper").Output()
		if err != nil {
			t.Fatalf("read helper for %s: %v", directory, err)
		}
		return strings.TrimSpace(string(output))
	}
	if got := config(root); got != "!agenticform-node git-credential agent-a" {
		t.Fatalf("root helper = %q", got)
	}
	if got := config(worktree); got != "!agenticform-node git-credential agent-b" {
		t.Fatalf("worktree helper = %q", got)
	}
}
