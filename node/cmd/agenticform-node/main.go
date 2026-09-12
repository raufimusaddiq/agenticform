package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const version = "0.2.0"

type identity struct {
	NodeID       string `json:"nodeId"`
	Name         string `json:"name"`
	Fingerprint  string `json:"fingerprint"`
	PrivateKeyPK string `json:"privateKeyPkcs8"`
	PublicKeyPK  string `json:"publicKeySpki"`
}

type enrollmentResult struct {
	NodeID      string `json:"nodeId"`
	Name        string `json:"name"`
	Fingerprint string `json:"fingerprint"`
	TrustLevel  string `json:"trustLevel"`
}

type nodeCommand struct {
	ID                string `json:"id"`
	NodeID            string `json:"nodeId"`
	AgentID           string `json:"agentId"`
	RuntimeGeneration int64  `json:"runtimeGeneration"`
	CommandType       string `json:"commandType"`
	IdempotencyKey    string `json:"idempotencyKey"`
	PayloadJSON       string `json:"payloadJson"`
}

type completeRequest struct {
	Success    bool   `json:"success"`
	ResultJSON string `json:"resultJson,omitempty"`
	Error      string `json:"error,omitempty"`
}

type commandLedgerEntry struct {
	CommandID   string    `json:"commandId"`
	Fingerprint string    `json:"fingerprint"`
	State       string    `json:"state"`
	ResultJSON  string    `json:"resultJson,omitempty"`
	Error       string    `json:"error,omitempty"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type commandLedger struct {
	Entries map[string]commandLedgerEntry `json:"entries"`
}

type runtimeRecord struct {
	AgentID           string `json:"agentId"`
	RuntimeType       string `json:"runtimeType"`
	RuntimeGeneration int64  `json:"runtimeGeneration"`
	ThreadID          string `json:"threadId"`
	SourceDirectory   string `json:"sourceDirectory"`
	WorkingDirectory  string `json:"workingDirectory"`
	Branch            string `json:"branch"`
	RuntimeStatus     string `json:"runtimeStatus"`
}

type runtimeState struct {
	Runtimes map[string]runtimeRecord `json:"runtimes"`
}

type interactionView struct {
	ID           string `json:"id"`
	Status       string `json:"status"`
	ResponseJSON string `json:"responseJson"`
	Error        string `json:"error"`
}

type rpcMessage map[string]any

type rpcClient struct {
	server               string
	nodeID               string
	private              ed25519.PrivateKey
	cmd                  *exec.Cmd
	stdin                io.WriteCloser
	stdout               io.ReadCloser
	writeMu              sync.Mutex
	pendingMu            sync.Mutex
	pending              map[string]chan rpcMessage
	seq                  uint64
	http                 *http.Client
	runtimeGenerationFor func(any) int64
	notificationObserver func(string, any)
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	mode := "daemon"
	if len(os.Args) > 1 {
		mode = os.Args[1]
	}
	stateDir := env("AGENTICFORM_NODE_STATE", "/var/lib/agenticform-node")
	server := strings.TrimRight(env("AGENTICFORM_SERVER", ""), "/")
	if server == "" {
		fatal("AGENTICFORM_SERVER is required")
	}
	if err := requireSecureServerURL(server); err != nil {
		fatal(err.Error())
	}

	switch mode {
	case "enroll":
		if err := enroll(stateDir, server); err != nil {
			fatal(err.Error())
		}
	case "daemon":
		if err := daemon(stateDir, server); err != nil {
			fatal(err.Error())
		}
	case "git-credential":
		if err := gitCredentialHelper(stateDir, server, os.Args[2:]); err != nil {
			fatal(err.Error())
		}
	default:
		fatal("usage: agenticform-node [enroll|daemon|git-credential]")
	}
}

func enroll(stateDir, server string) error {
	token := os.Getenv("AGENTICFORM_ENROLLMENT_TOKEN")
	if token == "" {
		return errors.New("AGENTICFORM_ENROLLMENT_TOKEN is required for enroll")
	}
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		return err
	}
	identityPath := filepath.Join(stateDir, "identity.json")
	if _, err := os.Stat(identityPath); err == nil {
		return errors.New("node identity already exists; revoke/remove it before re-enrolling")
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return fmt.Errorf("generate node identity: %w", err)
	}
	publicDER, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return fmt.Errorf("encode public key: %w", err)
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return fmt.Errorf("encode private key: %w", err)
	}
	body, _ := json.Marshal(map[string]string{
		"token":           token,
		"publicKeyBase64": base64.StdEncoding.EncodeToString(publicDER),
	})
	req, _ := http.NewRequest(http.MethodPost, server+"/api/nodes/enroll", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("enroll request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("enroll rejected (%d): %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	var result enrollmentResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("decode enrollment: %w", err)
	}
	id := identity{
		NodeID:       result.NodeID,
		Name:         result.Name,
		Fingerprint:  result.Fingerprint,
		PrivateKeyPK: base64.StdEncoding.EncodeToString(privateDER),
		PublicKeyPK:  base64.StdEncoding.EncodeToString(publicDER),
	}
	encoded, _ := json.MarshalIndent(id, "", "  ")
	if err := os.WriteFile(identityPath, encoded, 0600); err != nil {
		return fmt.Errorf("persist node identity: %w", err)
	}
	log.Printf("enrolled node %s (%s)", id.Name, id.NodeID)
	return nil
}

func daemon(stateDir, server string) error {
	id, private, err := loadIdentity(filepath.Join(stateDir, "identity.json"))
	if err != nil {
		return err
	}
	ledger, err := loadCommandLedger(filepath.Join(stateDir, "command-ledger.json"))
	if err != nil {
		return err
	}
	runtimes, err := loadRuntimeState(filepath.Join(stateDir, "runtime-state.json"))
	if err != nil {
		return err
	}
	d := &daemonRuntime{
		stateDir: stateDir,
		server:   server,
		id:       id,
		private:  private,
		http:     &http.Client{Timeout: 45 * time.Second},
		ledger:   ledger,
		runtimes: runtimes,
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.heartbeatLoop(ctx)
	log.Printf("node %s (%s) connected to %s", id.Name, id.NodeID, server)
	return d.commandLoop(ctx)
}

type daemonRuntime struct {
	stateDir string
	server   string
	id       identity
	private  ed25519.PrivateKey
	http     *http.Client
	codexMu  sync.Mutex
	codex    *rpcClient
	stateMu  sync.Mutex
	ledger   commandLedger
	runtimes runtimeState
}

func (d *daemonRuntime) heartbeatLoop(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		if err := d.heartbeat(); err != nil {
			log.Printf("heartbeat failed: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (d *daemonRuntime) heartbeat() error {
	hostname, _ := os.Hostname()
	codexVersion, codexOK := detectCodex()
	capabilities, _ := json.Marshal(map[string]any{
		"git": commandExists("git"),
		"codex": codexOK,
		"runtimes": map[string]any{
			"CODEX": map[string]any{
				"available":     codexOK,
				"authenticated": codexOK,
				"version":       codexVersion,
			},
		},
	})
	labels, _ := json.Marshal(map[string]string{"runtime": "agenticform-node"})
	d.stateMu.Lock()
	runtimes := make([]runtimeRecord, 0, len(d.runtimes.Runtimes))
	for _, record := range d.runtimes.Runtimes {
		runtimes = append(runtimes, record)
	}
	d.stateMu.Unlock()
	sort.Slice(runtimes, func(i, j int) bool { return runtimes[i].AgentID < runtimes[j].AgentID })
	body, _ := json.Marshal(map[string]any{
		"labelsJson":       string(labels),
		"capabilitiesJson": string(capabilities),
		"maxAgents":        envInt("AGENTICFORM_NODE_MAX_AGENTS", 4),
		"os":               runtime.GOOS,
		"arch":             runtime.GOARCH,
		"hostname":         hostname,
		"nodeVersion":      version,
		"codexVersion":     codexVersion,
		"cpuCores":         runtime.NumCPU(),
		"memoryMb":         nil,
		"diskFreeMb":       diskFreeMB(d.stateDir),
		"runtimes":         runtimes,
	})
	path := "/api/nodes/" + d.id.NodeID + "/heartbeat"
	resp, err := d.signedRequest(http.MethodPost, path, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("heartbeat rejected (%d): %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	return nil
}

func (d *daemonRuntime) commandLoop(ctx context.Context) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		path := "/api/nodes/" + d.id.NodeID + "/commands/next"
		resp, err := d.signedRequest(http.MethodGet, path, nil)
		if err != nil {
			log.Printf("command poll failed: %v", err)
			time.Sleep(3 * time.Second)
			continue
		}
		if resp.StatusCode == http.StatusNoContent {
			resp.Body.Close()
			time.Sleep(1500 * time.Millisecond)
			continue
		}
		if resp.StatusCode/100 != 2 {
			data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			resp.Body.Close()
			log.Printf("command poll rejected (%d): %s", resp.StatusCode, strings.TrimSpace(string(data)))
			time.Sleep(3 * time.Second)
			continue
		}
		var command nodeCommand
		err = json.NewDecoder(resp.Body).Decode(&command)
		resp.Body.Close()
		if err != nil {
			log.Printf("decode command: %v", err)
			continue
		}
		result, commandErr := d.executeDurable(command)
		complete := completeRequest{Success: commandErr == nil}
		if commandErr != nil {
			complete.Error = safeError(commandErr)
		} else {
			encoded, _ := json.Marshal(result)
			complete.ResultJSON = string(encoded)
		}
		body, _ := json.Marshal(complete)
		completePath := "/api/nodes/" + d.id.NodeID + "/commands/" + command.ID + "/complete"
		if response, err := d.signedRequest(http.MethodPost, completePath, body); err != nil {
			log.Printf("command completion failed for %s: %v", command.ID, err)
		} else {
			data, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
			response.Body.Close()
			if response.StatusCode/100 != 2 {
				log.Printf("command completion rejected for %s (%d): %s", command.ID, response.StatusCode, strings.TrimSpace(string(data)))
			}
		}
	}
}

func (d *daemonRuntime) executeDurable(command nodeCommand) (map[string]any, error) {
	fingerprint := commandFingerprint(command)
	d.stateMu.Lock()
	if existing, ok := d.ledger.Entries[command.ID]; ok {
		d.stateMu.Unlock()
		if existing.Fingerprint != fingerprint {
			return nil, errors.New("command id was reused with a different payload")
		}
		switch existing.State {
		case "SUCCEEDED":
			var result map[string]any
			if err := json.Unmarshal([]byte(defaultJSON(existing.ResultJSON)), &result); err != nil {
				return nil, fmt.Errorf("decode cached command result: %w", err)
			}
			return result, nil
		case "FAILED":
			return nil, errors.New(existing.Error)
		default:
			return nil, errors.New("previous command execution was interrupted; refusing unsafe replay")
		}
	}
	d.ledger.Entries[command.ID] = commandLedgerEntry{
		CommandID: command.ID, Fingerprint: fingerprint, State: "STARTED", UpdatedAt: time.Now().UTC(),
	}
	if err := d.saveLedgerLocked(); err != nil {
		delete(d.ledger.Entries, command.ID)
		d.stateMu.Unlock()
		return nil, fmt.Errorf("persist command start fence: %w", err)
	}
	d.stateMu.Unlock()

	result, execErr := d.execute(command)
	entry := commandLedgerEntry{CommandID: command.ID, Fingerprint: fingerprint, UpdatedAt: time.Now().UTC()}
	if execErr != nil {
		entry.State = "FAILED"
		entry.Error = safeError(execErr)
	} else {
		entry.State = "SUCCEEDED"
		encoded, _ := json.Marshal(result)
		entry.ResultJSON = string(encoded)
	}

	d.stateMu.Lock()
	d.ledger.Entries[command.ID] = entry
	persistErr := d.saveLedgerLocked()
	d.stateMu.Unlock()
	if persistErr != nil {
		return nil, fmt.Errorf("command effect completed but terminal ledger write failed; command is fenced from replay: %w", persistErr)
	}
	return result, execErr
}

func (d *daemonRuntime) execute(command nodeCommand) (map[string]any, error) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(command.PayloadJSON), &payload); err != nil {
		return nil, fmt.Errorf("invalid command payload: %w", err)
	}
	generation := int64Value(payload, "runtimeGeneration")
	if generation != command.RuntimeGeneration {
		return nil, errors.New("command runtime generation does not match signed command payload")
	}
	switch command.CommandType {
	case "START_AGENT":
		return d.startAgent(command, payload)
	case "DISPATCH_TASK", "DELIVER_MESSAGE":
		return d.dispatch(command, payload)
	case "INTERRUPT_TURN":
		return d.interrupt(command, payload)
	case "CLEANUP_WORKSPACE":
		return d.cleanupWorkspace(command, payload)
	default:
		return nil, fmt.Errorf("unsupported node command: %s", command.CommandType)
	}
}

func (d *daemonRuntime) startAgent(command nodeCommand, payload map[string]any) (map[string]any, error) {
	repositoryURL := stringValue(payload, "repositoryUrl")
	projectSlug := safeSegment(stringValue(payload, "projectSlug"))
	agentID := safeSegment(stringValue(payload, "agentId"))
	baseBranch := stringValue(payload, "baseBranch")
	workspaceMode := stringValue(payload, "workspaceMode")
	agentName := stringValue(payload, "agentName")
	requestedBranch := optionalString(payload, "requestedBranch")
	if repositoryURL == "" || projectSlug == "" || agentID == "" || baseBranch == "" || command.RuntimeGeneration <= 0 {
		return nil, errors.New("START_AGENT missing repository/project/agent/base branch or runtime generation")
	}
	if command.AgentID != "" && command.AgentID != agentID {
		return nil, errors.New("START_AGENT agent id mismatch")
	}
	if err := validateRepositoryURL(repositoryURL); err != nil {
		return nil, err
	}

	repoRoot := filepath.Join(d.stateDir, "repos", projectSlug)
	if err := d.ensureProjectRepository(command, payload, repoRoot, repositoryURL); err != nil {
		return nil, err
	}

	workingDirectory := repoRoot
	branch := baseBranch
	if workspaceMode == "ISOLATED_WORKTREE" {
		branch = requestedBranch
		if branch == "" {
			branch = "agent/" + safeSegment(strings.ToLower(agentName)) + "-" + agentID[:min(8, len(agentID))]
		}
		workingDirectory = filepath.Join(d.stateDir, "worktrees", projectSlug, agentID, "g"+strconv.FormatInt(command.RuntimeGeneration, 10))
		if err := os.MkdirAll(filepath.Dir(workingDirectory), 0700); err != nil {
			return nil, err
		}
		if _, err := os.Stat(workingDirectory); errors.Is(err, os.ErrNotExist) {
			base := "origin/" + baseBranch
			if err := runGit(repoRoot, "rev-parse", "--verify", base); err != nil {
				defaultBranch := stringValue(payload, "defaultBranch")
				fallback := "origin/" + defaultBranch
				if defaultBranch != "" && runGit(repoRoot, "rev-parse", "--verify", fallback) == nil {
					base = fallback
				} else {
					base = baseBranch
				}
			}
			if err := runGit(repoRoot, "worktree", "add", "-b", branch, workingDirectory, base); err != nil {
				return nil, err
			}
		}
	} else {
		if err := runGit(repoRoot, "checkout", baseBranch); err != nil {
			if err := runGit(repoRoot, "checkout", "-B", baseBranch, "origin/"+baseBranch); err != nil {
				return nil, err
			}
		}
	}

	params, ok := payload["threadStartParams"].(map[string]any)
	if !ok {
		return nil, errors.New("START_AGENT missing threadStartParams")
	}
	params["cwd"] = workingDirectory
	client, err := d.ensureCodex()
	if err != nil {
		return nil, err
	}
	result, err := client.request("thread/start", params)
	if err != nil {
		return nil, err
	}
	threadID := nestedString(result, "thread", "id")
	if threadID == "" {
		return nil, errors.New("Codex thread/start returned no thread id")
	}
	record := runtimeRecord{
		AgentID: agentID, RuntimeType: "CODEX", RuntimeGeneration: command.RuntimeGeneration, ThreadID: threadID,
		SourceDirectory: repoRoot, WorkingDirectory: workingDirectory, Branch: branch, RuntimeStatus: "IDLE",
	}
	if err := d.putRuntime(record); err != nil {
		return nil, fmt.Errorf("persist runtime state: %w", err)
	}
	return map[string]any{
		"threadId": threadID, "sourceDirectory": repoRoot,
		"workingDirectory": workingDirectory, "branch": branch,
		"runtimeGeneration": command.RuntimeGeneration, "runtimeType": "CODEX",
	}, nil
}

func (d *daemonRuntime) dispatch(command nodeCommand, payload map[string]any) (map[string]any, error) {
	threadID := stringValue(payload, "threadId")
	prompt := stringValue(payload, "prompt")
	if threadID == "" || prompt == "" {
		return nil, errors.New(command.CommandType + " missing threadId or prompt")
	}
	if err := d.requireRuntime(command.AgentID, command.RuntimeGeneration, threadID); err != nil {
		return nil, err
	}
	clientMessageID := optionalString(payload, "clientMessageId")
	if clientMessageID == "" {
		if messageID := optionalString(payload, "messageId"); messageID != "" {
			clientMessageID = "agenticform-message:" + messageID + ":g" + strconv.FormatInt(command.RuntimeGeneration, 10)
		}
	}
	client, err := d.ensureCodex()
	if err != nil {
		return nil, err
	}
	params := map[string]any{
		"threadId": threadID,
		"clientUserMessageId": clientMessageID,
		"input": []map[string]any{{"type": "text", "text": prompt}},
	}
	result, err := client.request("thread/queue/add", params)
	if err == nil {
		queueID := nestedString(result, "queuedSubmission", "id")
		_, _ = client.request("thread/resume", map[string]any{"threadId": threadID})
		_ = d.setRuntimeStatus(command.AgentID, command.RuntimeGeneration, "WORKING")
		return map[string]any{"queuedSubmissionId": queueID}, nil
	}
	result, err = client.request("turn/start", map[string]any{
		"threadId": threadID,
		"input":    []map[string]any{{"type": "text", "text": prompt}},
	})
	if err != nil {
		return nil, err
	}
	_ = d.setRuntimeStatus(command.AgentID, command.RuntimeGeneration, "WORKING")
	return map[string]any{"turnId": nestedString(result, "turn", "id")}, nil
}

func (d *daemonRuntime) interrupt(command nodeCommand, payload map[string]any) (map[string]any, error) {
	threadID := stringValue(payload, "threadId")
	turnID := stringValue(payload, "turnId")
	if threadID == "" || turnID == "" {
		return nil, errors.New("INTERRUPT_TURN missing threadId or turnId")
	}
	if err := d.requireRuntime(command.AgentID, command.RuntimeGeneration, threadID); err != nil {
		return nil, err
	}
	client, err := d.ensureCodex()
	if err != nil {
		return nil, err
	}
	_, err = client.request("turn/interrupt", map[string]any{"threadId": threadID, "turnId": turnID})
	if err == nil {
		_ = d.setRuntimeStatus(command.AgentID, command.RuntimeGeneration, "IDLE")
	}
	return map[string]any{"interrupted": err == nil}, err
}

func (d *daemonRuntime) cleanupWorkspace(command nodeCommand, payload map[string]any) (map[string]any, error) {
	threadID := optionalString(payload, "threadId")
	d.stateMu.Lock()
	record, ok := d.runtimes.Runtimes[command.AgentID]
	d.stateMu.Unlock()
	if !ok || record.RuntimeGeneration != command.RuntimeGeneration {
		return nil, errors.New("runtime is not owned by this generation")
	}
	if threadID != "" && record.ThreadID != threadID {
		return nil, errors.New("cleanup thread id does not match runtime")
	}
	if record.WorkingDirectory == "" || record.WorkingDirectory == record.SourceDirectory {
		return nil, errors.New("shared project workspace is not eligible for automatic cleanup")
	}
	root := filepath.Join(d.stateDir, "worktrees")
	if !withinRoot(root, record.WorkingDirectory) {
		return nil, errors.New("workspace is outside the managed worktree root")
	}
	status, err := exec.Command("git", "-C", record.WorkingDirectory, "status", "--porcelain").Output()
	if err != nil {
		return nil, fmt.Errorf("inspect worktree: %w", err)
	}
	if strings.TrimSpace(string(status)) != "" {
		return nil, errors.New("worktree is dirty; cleanup refused")
	}
	if record.Branch != "" {
		defaultBranch := stringValue(payload, "defaultBranch")
		target := "origin/HEAD"
		if defaultBranch != "" {
			target = "origin/" + defaultBranch
		}
		cmd := exec.Command("git", "-C", record.SourceDirectory, "merge-base", "--is-ancestor", record.Branch, target)
		if err := cmd.Run(); err != nil {
			return nil, errors.New("worktree branch is not proven merged into the default branch")
		}
	}
	if err := runGit(record.SourceDirectory, "worktree", "remove", record.WorkingDirectory); err != nil {
		return nil, err
	}
	if record.Branch != "" {
		_ = runGit(record.SourceDirectory, "branch", "-d", record.Branch)
	}
	if err := d.deleteRuntime(command.AgentID, command.RuntimeGeneration); err != nil {
		return nil, err
	}
	return map[string]any{"cleaned": true, "workingDirectory": record.WorkingDirectory}, nil
}

func (d *daemonRuntime) ensureCodex() (*rpcClient, error) {
	d.codexMu.Lock()
	defer d.codexMu.Unlock()
	if d.codex != nil && d.codex.cmd != nil && d.codex.cmd.Process != nil {
		return d.codex, nil
	}
	client, err := startCodex(d.server, d.id.NodeID, d.private, d.http,
		d.generationForParams, d.observeNotification)
	if err != nil {
		return nil, err
	}
	d.codex = client
	return client, nil
}

func startCodex(server, nodeID string, private ed25519.PrivateKey, httpClient *http.Client,
	generationFor func(any) int64, notificationObserver func(string, any)) (*rpcClient, error) {
	cmd := exec.Command("codex", "app-server", "--stdio")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start codex app-server: %w", err)
	}
	client := &rpcClient{server: server, nodeID: nodeID, private: private, cmd: cmd,
		stdin: stdin, stdout: stdout, pending: make(map[string]chan rpcMessage), http: httpClient,
		runtimeGenerationFor: generationFor, notificationObserver: notificationObserver}
	go client.readLoop()
	if _, err := client.request("initialize", map[string]any{
		"clientInfo":   map[string]any{"name": "agenticform-node", "version": version},
		"capabilities": map[string]any{"experimentalApi": true},
	}); err != nil {
		_ = cmd.Process.Kill()
		return nil, err
	}
	if err := client.notify("initialized", map[string]any{}); err != nil {
		_ = cmd.Process.Kill()
		return nil, err
	}
	return client, nil
}

func (c *rpcClient) request(method string, params any) (rpcMessage, error) {
	c.pendingMu.Lock()
	c.seq++
	id := strconv.FormatUint(c.seq, 10)
	ch := make(chan rpcMessage, 1)
	c.pending[id] = ch
	c.pendingMu.Unlock()

	if err := c.write(rpcMessage{"id": c.seq, "method": method, "params": params}); err != nil {
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		return nil, err
	}
	select {
	case message := <-ch:
		if rpcErr, ok := message["error"]; ok && rpcErr != nil {
			encoded, _ := json.Marshal(rpcErr)
			return nil, fmt.Errorf("codex %s failed: %s", method, encoded)
		}
		result, _ := message["result"].(map[string]any)
		return result, nil
	case <-time.After(45 * time.Second):
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		return nil, fmt.Errorf("codex %s timed out", method)
	}
}

func (c *rpcClient) notify(method string, params any) error {
	return c.write(rpcMessage{"method": method, "params": params})
}

func (c *rpcClient) write(message rpcMessage) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = c.stdin.Write(append(data, '\n'))
	return err
}

func (c *rpcClient) readLoop() {
	scanner := bufio.NewScanner(c.stdout)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		var message rpcMessage
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
			continue
		}
		_, hasMethod := message["method"].(string)
		id, hasID := message["id"]
		if hasID && hasMethod {
			go c.forwardServerRequest(id, message)
			continue
		}
		if hasID {
			idText := fmt.Sprint(id)
			if number, ok := id.(float64); ok {
				idText = strconv.FormatInt(int64(number), 10)
			}
			c.pendingMu.Lock()
			ch := c.pending[idText]
			delete(c.pending, idText)
			c.pendingMu.Unlock()
			if ch != nil {
				ch <- message
			}
			continue
		}
		if method, ok := message["method"].(string); ok && shouldForwardNotification(method) {
			if c.notificationObserver != nil {
				c.notificationObserver(method, message["params"])
			}
			go c.forwardNotification(method, message["params"])
		}
	}
}

func (c *rpcClient) forwardServerRequest(id any, message rpcMessage) {
	generation := int64(0)
	if c.runtimeGenerationFor != nil {
		generation = c.runtimeGenerationFor(message["params"])
	}
	if generation <= 0 {
		_ = c.write(rpcMessage{"id": id, "error": map[string]any{"code": -32000, "message": "runtime generation is unavailable"}})
		return
	}
	body, _ := json.Marshal(map[string]any{
		"requestId": id, "method": message["method"], "params": message["params"],
		"runtimeGeneration": generation,
	})
	path := "/api/nodes/" + c.nodeID + "/codex/server-request"
	resp, err := signedHTTP(c.http, c.server, c.nodeID, c.private, http.MethodPost, path, body)
	if err != nil {
		_ = c.write(rpcMessage{"id": id, "error": map[string]any{"code": -32000, "message": safeError(err)}})
		return
	}
	view, err := decodeInteractionResponse(resp)
	if err != nil {
		_ = c.write(rpcMessage{"id": id, "error": map[string]any{"code": -32000, "message": safeError(err)}})
		return
	}

	for view.Status == "PENDING" {
		time.Sleep(1500 * time.Millisecond)
		pollPath := "/api/nodes/" + c.nodeID + "/codex/server-request/" + view.ID
		resp, err = signedHTTP(c.http, c.server, c.nodeID, c.private, http.MethodGet, pollPath, nil)
		if err != nil {
			log.Printf("remote Codex interaction poll failed %s: %v", view.ID, err)
			continue
		}
		view, err = decodeInteractionResponse(resp)
		if err != nil {
			log.Printf("remote Codex interaction poll decode failed %s: %v", view.ID, err)
			continue
		}
	}
	if view.Status == "FAILED" {
		_ = c.write(rpcMessage{"id": id, "error": map[string]any{"code": -32000, "message": defaultString(view.Error, "remote interaction failed")}})
		return
	}
	if view.Status != "READY" && view.Status != "CONSUMED" {
		_ = c.write(rpcMessage{"id": id, "error": map[string]any{"code": -32000, "message": "unexpected remote interaction state: " + view.Status}})
		return
	}
	var result any
	if err := json.Unmarshal([]byte(defaultJSON(view.ResponseJSON)), &result); err != nil {
		_ = c.write(rpcMessage{"id": id, "error": map[string]any{"code": -32000, "message": "invalid durable control-plane response"}})
		return
	}
	if err := c.write(rpcMessage{"id": id, "result": result}); err != nil {
		return
	}
	if view.Status == "READY" {
		ackPath := "/api/nodes/" + c.nodeID + "/codex/server-request/" + view.ID + "/ack"
		if ack, err := signedHTTP(c.http, c.server, c.nodeID, c.private, http.MethodPost, ackPath, nil); err == nil {
			io.Copy(io.Discard, io.LimitReader(ack.Body, 1024))
			ack.Body.Close()
		}
	}
}

func decodeInteractionResponse(resp *http.Response) (interactionView, error) {
	if resp == nil {
		return interactionView{}, errors.New("empty control-plane response")
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return interactionView{}, fmt.Errorf("control plane rejected interaction (%d): %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	var view interactionView
	if err := json.NewDecoder(resp.Body).Decode(&view); err != nil {
		return interactionView{}, err
	}
	return view, nil
}

func (c *rpcClient) forwardNotification(method string, params any) {
	generation := int64(0)
	if c.runtimeGenerationFor != nil {
		generation = c.runtimeGenerationFor(params)
	}
	if generation <= 0 {
		log.Printf("dropping %s notification without current runtime generation", method)
		return
	}
	body, _ := json.Marshal(map[string]any{
		"method": method, "params": params, "runtimeGeneration": generation,
	})
	path := "/api/nodes/" + c.nodeID + "/codex/notification"
	resp, err := signedHTTP(c.http, c.server, c.nodeID, c.private, http.MethodPost, path, body)
	if err == nil && resp != nil {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 1024))
		resp.Body.Close()
	}
}

func shouldForwardNotification(method string) bool {
	return method == "item/started" || method == "turn/completed"
}

func (d *daemonRuntime) generationForParams(params any) int64 {
	threadID := threadIDFromParams(params)
	if threadID == "" {
		return 0
	}
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	for _, record := range d.runtimes.Runtimes {
		if record.ThreadID == threadID {
			return record.RuntimeGeneration
		}
	}
	return 0
}

func (d *daemonRuntime) observeNotification(method string, params any) {
	threadID := threadIDFromParams(params)
	if threadID == "" {
		return
	}
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	changed := false
	for key, record := range d.runtimes.Runtimes {
		if record.ThreadID != threadID {
			continue
		}
		switch method {
		case "item/started":
			record.RuntimeStatus = "WORKING"
		case "turn/completed":
			record.RuntimeStatus = "IDLE"
		}
		d.runtimes.Runtimes[key] = record
		changed = true
	}
	if changed {
		_ = d.saveRuntimeStateLocked()
	}
}

func threadIDFromParams(params any) string {
	object, ok := params.(map[string]any)
	if !ok {
		return ""
	}
	if value, ok := object["threadId"].(string); ok && value != "" {
		return value
	}
	if thread, ok := object["thread"].(map[string]any); ok {
		if value, ok := thread["id"].(string); ok {
			return value
		}
	}
	return ""
}

func (d *daemonRuntime) requireRuntime(agentID string, generation int64, threadID string) error {
	if agentID == "" || generation <= 0 {
		return errors.New("remote command is missing agent runtime identity")
	}
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	record, ok := d.runtimes.Runtimes[agentID]
	if !ok || record.RuntimeGeneration != generation || record.ThreadID != threadID {
		return errors.New("remote command targets a stale or unknown runtime")
	}
	return nil
}

func (d *daemonRuntime) putRuntime(record runtimeRecord) error {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	if d.runtimes.Runtimes == nil {
		d.runtimes.Runtimes = map[string]runtimeRecord{}
	}
	if current, ok := d.runtimes.Runtimes[record.AgentID]; ok && current.RuntimeGeneration > record.RuntimeGeneration {
		return errors.New("refusing to replace a newer runtime generation")
	}
	d.runtimes.Runtimes[record.AgentID] = record
	return d.saveRuntimeStateLocked()
}

func (d *daemonRuntime) setRuntimeStatus(agentID string, generation int64, status string) error {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	record, ok := d.runtimes.Runtimes[agentID]
	if !ok || record.RuntimeGeneration != generation {
		return errors.New("runtime generation is not current")
	}
	record.RuntimeStatus = status
	d.runtimes.Runtimes[agentID] = record
	return d.saveRuntimeStateLocked()
}

func (d *daemonRuntime) deleteRuntime(agentID string, generation int64) error {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	record, ok := d.runtimes.Runtimes[agentID]
	if !ok || record.RuntimeGeneration != generation {
		return errors.New("runtime generation is not current")
	}
	delete(d.runtimes.Runtimes, agentID)
	return d.saveRuntimeStateLocked()
}

func (d *daemonRuntime) signedRequest(method, path string, body []byte) (*http.Response, error) {
	return signedHTTP(d.http, d.server, d.id.NodeID, d.private, method, path, body)
}

func signedHTTP(client *http.Client, server, nodeID string, private ed25519.PrivateKey,
	method, path string, body []byte) (*http.Response, error) {
	if body == nil {
		body = []byte{}
	}
	timestamp := strconv.FormatInt(time.Now().UnixMilli(), 10)
	nonceBytes := make([]byte, 18)
	if _, err := rand.Read(nonceBytes); err != nil {
		return nil, err
	}
	nonce := base64.RawURLEncoding.EncodeToString(nonceBytes)
	digest := sha256.Sum256(body)
	canonical := nodeID + "\n" + timestamp + "\n" + nonce + "\n" + strings.ToUpper(method) + "\n" + path + "\n" + hex.EncodeToString(digest[:])
	signature := ed25519.Sign(private, []byte(canonical))
	req, err := http.NewRequest(method, server+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-AF-Timestamp", timestamp)
	req.Header.Set("X-AF-Nonce", nonce)
	req.Header.Set("X-AF-Signature", base64.StdEncoding.EncodeToString(signature))
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	return client.Do(req)
}

func loadIdentity(path string) (identity, ed25519.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return identity{}, nil, fmt.Errorf("load node identity: %w", err)
	}
	var id identity
	if err := json.Unmarshal(data, &id); err != nil {
		return identity{}, nil, err
	}
	privateDER, err := base64.StdEncoding.DecodeString(id.PrivateKeyPK)
	if err != nil {
		return identity{}, nil, err
	}
	key, err := x509.ParsePKCS8PrivateKey(privateDER)
	if err != nil {
		return identity{}, nil, err
	}
	private, ok := key.(ed25519.PrivateKey)
	if !ok {
		return identity{}, nil, errors.New("stored node key is not Ed25519")
	}
	return id, private, nil
}

func loadCommandLedger(path string) (commandLedger, error) {
	ledger := commandLedger{Entries: map[string]commandLedgerEntry{}}
	if err := loadOptionalJSON(path, &ledger); err != nil {
		return commandLedger{}, fmt.Errorf("load command ledger: %w", err)
	}
	if ledger.Entries == nil {
		ledger.Entries = map[string]commandLedgerEntry{}
	}
	return ledger, nil
}

func loadRuntimeState(path string) (runtimeState, error) {
	state := runtimeState{Runtimes: map[string]runtimeRecord{}}
	if err := loadOptionalJSON(path, &state); err != nil {
		return runtimeState{}, fmt.Errorf("load runtime state: %w", err)
	}
	if state.Runtimes == nil {
		state.Runtimes = map[string]runtimeRecord{}
	}
	return state, nil
}

func loadOptionalJSON(path string, target any) error {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func (d *daemonRuntime) saveLedgerLocked() error {
	cutoff := time.Now().UTC().Add(-7 * 24 * time.Hour)
	if len(d.ledger.Entries) > 5000 {
		for key, entry := range d.ledger.Entries {
			if entry.UpdatedAt.Before(cutoff) && entry.State != "STARTED" {
				delete(d.ledger.Entries, key)
			}
		}
	}
	return writeJSONAtomic(filepath.Join(d.stateDir, "command-ledger.json"), d.ledger)
}

func (d *daemonRuntime) saveRuntimeStateLocked() error {
	return writeJSONAtomic(filepath.Join(d.stateDir, "runtime-state.json"), d.runtimes)
}

func writeJSONAtomic(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".agenticform-state-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(encoded); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func commandFingerprint(command nodeCommand) string {
	digest := sha256.Sum256([]byte(command.CommandType + "\n" + command.IdempotencyKey + "\n" +
		strconv.FormatInt(command.RuntimeGeneration, 10) + "\n" + command.PayloadJSON))
	return hex.EncodeToString(digest[:])
}

func ensureRepository(repoRoot, repositoryURL string) error {
	if _, err := os.Stat(filepath.Join(repoRoot, ".git")); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(repoRoot), 0700); err != nil {
		return err
	}
	cmd := exec.Command("git", "clone", "--no-checkout", repositoryURL, repoRoot)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git clone failed: %w", err)
	}
	return nil
}

func runGit(repo string, args ...string) error {
	argv := append([]string{"-C", repo}, args...)
	cmd := exec.Command("git", argv...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git %s failed: %w", strings.Join(args, " "), err)
	}
	return nil
}

func validateRepositoryURL(value string) error {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("repository URL must be credential-free HTTPS")
	}
	return nil
}

func requireSecureServerURL(value string) error {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" {
		return errors.New("AGENTICFORM_SERVER must be an absolute URL")
	}
	host := strings.ToLower(u.Hostname())
	if u.Scheme != "https" && host != "localhost" && host != "127.0.0.1" && host != "::1" {
		return errors.New("non-local Agenticform server must use HTTPS")
	}
	return nil
}

func detectCodex() (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "codex", "--version").CombinedOutput()
	if err != nil {
		return "", false
	}
	versionText := strings.TrimSpace(string(out))
	if os.Getenv("OPENAI_API_KEY") != "" {
		return versionText, true
	}
	statusCtx, statusCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer statusCancel()
	if err := exec.CommandContext(statusCtx, "codex", "login", "status").Run(); err != nil {
		return versionText, false
	}
	return versionText, true
}

func withinRoot(root, path string) bool {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	pathAbs, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(rootAbs, pathAbs)
	return err == nil && rel != "." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != ".."
}

func commandExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func diskFreeMB(path string) int64 {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0
	}
	return int64(stat.Bavail) * int64(stat.Bsize) / 1024 / 1024
}

func stringValue(values map[string]any, key string) string {
	value, _ := values[key].(string)
	return strings.TrimSpace(value)
}

func int64Value(values map[string]any, key string) int64 {
	switch value := values[key].(type) {
	case float64:
		return int64(value)
	case int64:
		return value
	case json.Number:
		parsed, _ := value.Int64()
		return parsed
	case string:
		parsed, _ := strconv.ParseInt(value, 10, 64)
		return parsed
	default:
		return 0
	}
}

func optionalString(values map[string]any, key string) string { return stringValue(values, key) }

func nestedString(values map[string]any, path ...string) string {
	var current any = values
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return ""
		}
		current = object[key]
	}
	value, _ := current.(string)
	return value
}

func safeSegment(value string) string {
	value = strings.TrimSpace(value)
	var out strings.Builder
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			out.WriteRune(r)
		}
	}
	return strings.Trim(out.String(), ".")
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envInt(name string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(name))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func safeError(err error) string {
	if err == nil {
		return ""
	}
	text := err.Error()
	if len(text) > 1000 {
		return text[:1000]
	}
	return text
}

func defaultJSON(value string) string {
	if strings.TrimSpace(value) == "" {
		return "{}"
	}
	return value
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func fatal(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
