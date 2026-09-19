package main

import (
	"bytes"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type gitCredentialResponse struct {
	Username  string    `json:"username"`
	Password  string    `json:"password"`
	ExpiresAt time.Time `json:"expiresAt"`
}

func gitCredentialHelper(stateDir, server string, args []string) error {
	if len(args) < 7 {
		return errors.New("git credential helper requires agentId runtimeGeneration projectId repositoryUrl runtimeType runtimeSessionId operation")
	}
	agentID := args[0]
	generation, err := strconv.ParseInt(args[1], 10, 64)
	if err != nil || generation <= 0 {
		return errors.New("invalid git credential runtime generation")
	}
	projectID := args[2]
	repositoryURL := args[3]
	runtimeType := args[4]
	runtimeSessionID := args[5]
	operation := args[6]
	_, _ = io.Copy(io.Discard, io.LimitReader(os.Stdin, 4096))
	if operation != "get" {
		return nil
	}
	id, private, encryptionPrivate, err := loadIdentity(filepath.Join(stateDir, "identity.json"))
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]any{
		"agentId": agentID, "runtimeGeneration": generation,
		"projectId": projectID, "repositoryUrl": repositoryURL,
		"runtimeType": runtimeType, "runtimeSessionId": runtimeSessionID,
	})
	mode := "runtime"
	if runtimeSessionID == "" {
		mode = "bootstrap"
	}
	path := "/api/nodes/" + id.NodeID + "/git-credential/" + mode
	client := newHTTPClient(20 * time.Second)
	resp, err := signedHTTP(client, server, id.NodeID, private, http.MethodPost, path, body)
	if err != nil {
		return fmt.Errorf("request Git credential: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("Git credential request rejected (%d): %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	var credential gitCredentialResponse
	if err := json.NewDecoder(resp.Body).Decode(&credential); err != nil {
		return err
	}
	if credential.Username == "" || credential.Password == "" || credential.ExpiresAt.Before(time.Now().Add(time.Minute)) {
		return errors.New("control plane returned an invalid or nearly expired Git credential")
	}
	credential.Password, err = decryptCredential(credential.Password, encryptionPrivate)
	if err != nil {
		return err
	}
	fmt.Printf("username=%s\npassword=%s\n\n", credential.Username, credential.Password)
	return nil
}

func decryptCredential(encoded string, private *rsa.PrivateKey) (string, error) {
	if private == nil || !strings.HasPrefix(encoded, "afenc1.") {
		return "", errors.New("control plane returned an invalid encrypted Git credential")
	}
	ciphertext, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(encoded, "afenc1."))
	if err != nil {
		return "", errors.New("control plane returned an invalid encrypted Git credential")
	}
	plaintext, err := rsa.DecryptOAEP(sha256.New(), nil, private, ciphertext, nil)
	if err != nil {
		return "", errors.New("unable to decrypt Git credential")
	}
	return string(plaintext), nil
}

func (d *daemonRuntime) ensureProjectRepository(command nodeCommand, payload map[string]any,
	repoRoot, repositoryURL string) error {
	projectID := stringValue(payload, "projectId")
	if projectID == "" {
		return errors.New("START_AGENT missing projectId for repository authorization")
	}
	runtimeType := stringValue(payload, "runtimeType")
	helper := credentialHelperCommand(command.AgentID, command.RuntimeGeneration, projectID, repositoryURL, runtimeType, "")
	if _, err := os.Stat(filepath.Join(repoRoot, ".git")); err == nil {
		if err := configureCredentialHelper(repoRoot, helper); err != nil {
			return err
		}
		return runGit(repoRoot, "fetch", "--prune", "origin")
	}
	if err := os.MkdirAll(filepath.Dir(repoRoot), 0700); err != nil {
		return err
	}
	_ = os.RemoveAll(repoRoot)
	cmd := exec.Command("git",
		"-c", "credential.helper=",
		"-c", "credential.helper="+helper,
		"clone", "--no-checkout", repositoryURL, repoRoot)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		_ = os.RemoveAll(repoRoot)
		return fmt.Errorf("git clone failed: %w", err)
	}
	return configureCredentialHelper(repoRoot, helper)
}

func configureCredentialHelper(repoRoot, helper string) error {
	// Worktrees share the repository config by default. Enable per-worktree config
	// before installing a runtime-scoped helper, otherwise the last agent started
	// silently replaces Git credentials for every other agent.
	if err := runGit(repoRoot, "config", "extensions.worktreeConfig", "true"); err != nil {
		return err
	}
	// Remove any pre-existing shared helper. Existing repositories may have been
	// configured before worktree isolation was enabled.
	if err := runGit(repoRoot, "config", "--local", "--replace-all", "credential.helper", ""); err != nil {
		return err
	}
	// Empty the inherited helper chain first so node-local or host credentials cannot silently
	// broaden access. The only active helper for this repo is the generation-scoped broker.
	if err := runGit(repoRoot, "config", "--worktree", "--replace-all", "credential.helper", ""); err != nil {
		return err
	}
	return runGit(repoRoot, "config", "--worktree", "--add", "credential.helper", helper)
}

func configureProjectRuntimeCredentialHelper(repoRoot, workingDirectory string, command nodeCommand,
	projectID, repositoryURL, runtimeType, runtimeSessionID string) error {
	helper := credentialHelperCommand(command.AgentID, command.RuntimeGeneration, projectID, repositoryURL, runtimeType, runtimeSessionID)
	if err := configureCredentialHelper(repoRoot, helper); err != nil {
		return err
	}
	if workingDirectory != repoRoot {
		return configureCredentialHelper(workingDirectory, helper)
	}
	return nil
}

func credentialHelperCommand(agentID string, generation int64, projectID, repositoryURL, runtimeType, runtimeSessionID string) string {
	return "!agenticform-node git-credential " + shellQuote(agentID) + " " +
		shellQuote(strconv.FormatInt(generation, 10)) + " " +
		shellQuote(projectID) + " " + shellQuote(repositoryURL) + " " +
		shellQuote(runtimeType) + " " + shellQuote(runtimeSessionID)
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

// Keep bytes imported in this file intentionally unavailable to credential output paths; this
// compile-time reference also makes accidental replacement with URL-embedded credentials obvious.
var _ = bytes.MinRead
