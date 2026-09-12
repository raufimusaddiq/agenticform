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
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const version = "0.1.0"

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
	ID             string `json:"id"`
	NodeID         string `json:"nodeId"`
	AgentID        string `json:"agentId"`
	CommandType    string `json:"commandType"`
	IdempotencyKey string `json:"idempotencyKey"`
	PayloadJSON    string `json:"payloadJson"`
}

type completeRequest struct {
	Success    bool   `json:"success"`
	ResultJSON string `json:"resultJson,omitempty"`
	Error      string `json:"error,omitempty"`
}

type rpcMessage map[string]any

type rpcClient struct {
	server    string
	nodeID    string
	private   ed25519.PrivateKey
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	stdout    io.ReadCloser
	writeMu   sync.Mutex
	pendingMu sync.Mutex
	pending   map[string]chan rpcMessage
	seq       uint64
	http      *http.Client
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
	default:
		fatal("usage: agenticform-node [enroll|daemon]")
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
	d := &daemonRuntime{
		stateDir: stateDir,
		server:   server,
		id:       id,
		private:  private,
		http: &http.Client{Timeout: 45 * time.Second},
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
	capabilities, _ := json.Marshal(map[string]bool{"git": commandExists("git"), "codex": codexOK})
	labels, _ := json.Marshal(map[string]string{"runtime": "agenticform-node"})
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
	})
	path := "/api/nodes/" + d.id.NodeID + "/heartbeat"
	_, err := d.signedRequest(http.MethodPost, path, body)
	return err
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
		result, commandErr := d.execute(command)
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
			io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
			response.Body.Close()
		}
	}
}

func (d *daemonRuntime) execute(command nodeCommand) (map[string]any, error) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(command.PayloadJSON), &payload); err != nil {
		return nil, fmt.Errorf("invalid command payload: %w", err)
	}
	switch command.CommandType {
	case "START_AGENT":
		return d.startAgent(payload)
	case "DISPATCH_TASK", "DELIVER_MESSAGE":
		return d.dispatch(payload, command.CommandType)
	case "INTERRUPT_TURN":
		return d.interrupt(payload)
	default:
		return nil, fmt.Errorf("unsupported node command: %s", command.CommandType)
	}
}

func (d *daemonRuntime) startAgent(payload map[string]any) (map[string]any, error) {
	repositoryURL := stringValue(payload, "repositoryUrl")
	projectSlug := safeSegment(stringValue(payload, "projectSlug"))
	agentID := safeSegment(stringValue(payload, "agentId"))
	baseBranch := stringValue(payload, "baseBranch")
	workspaceMode := stringValue(payload, "workspaceMode")
	agentName := stringValue(payload, "agentName")
	requestedBranch := optionalString(payload, "requestedBranch")
	if repositoryURL == "" || projectSlug == "" || agentID == "" || baseBranch == "" {
		return nil, errors.New("START_AGENT missing repository/project/agent/base branch")
	}
	if err := validateRepositoryURL(repositoryURL); err != nil {
		return nil, err
	}

	repoRoot := filepath.Join(d.stateDir, "repos", projectSlug)
	if err := ensureRepository(repoRoot, repositoryURL); err != nil {
		return nil, err
	}
	if err := runGit(repoRoot, "fetch", "--prune", "origin"); err != nil {
		return nil, err
	}

	workingDirectory := repoRoot
	branch := baseBranch
	if workspaceMode == "ISOLATED_WORKTREE" {
		branch = requestedBranch
		if branch == "" {
			branch = "agent/" + safeSegment(strings.ToLower(agentName)) + "-" + agentID[:min(8, len(agentID))]
		}
		workingDirectory = filepath.Join(d.stateDir, "worktrees", projectSlug, agentID)
		if err := os.MkdirAll(filepath.Dir(workingDirectory), 0700); err != nil {
			return nil, err
		}
		if _, err := os.Stat(workingDirectory); errors.Is(err, os.ErrNotExist) {
			base := "origin/" + baseBranch
			if err := runGit(repoRoot, "rev-parse", "--verify", base); err != nil {
				base = baseBranch
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
	return map[string]any{
		"threadId":         threadID,
		"sourceDirectory":  repoRoot,
		"workingDirectory": workingDirectory,
		"branch":           branch,
	}, nil
}

func (d *daemonRuntime) dispatch(payload map[string]any, commandType string) (map[string]any, error) {
	threadID := stringValue(payload, "threadId")
	prompt := stringValue(payload, "prompt")
	if threadID == "" || prompt == "" {
		return nil, errors.New(commandType + " missing threadId or prompt")
	}
	clientMessageID := optionalString(payload, "clientMessageId")
	if clientMessageID == "" {
		if messageID := optionalString(payload, "messageId"); messageID != "" {
			clientMessageID = "agenticform-message:" + messageID
		}
	}
	client, err := d.ensureCodex()
	if err != nil {
		return nil, err
	}
	params := map[string]any{
		"threadId":            threadID,
		"clientUserMessageId": clientMessageID,
		"input": []map[string]any{{"type": "text", "text": prompt}},
	}
	result, err := client.request("thread/queue/add", params)
	if err == nil {
		queueID := nestedString(result, "queuedSubmission", "id")
		_, _ = client.request("thread/resume", map[string]any{"threadId": threadID})
		return map[string]any{"queuedSubmissionId": queueID}, nil
	}
	result, err = client.request("turn/start", map[string]any{
		"threadId": threadID,
		"input":    []map[string]any{{"type": "text", "text": prompt}},
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"turnId": nestedString(result, "turn", "id")}, nil
}

func (d *daemonRuntime) interrupt(payload map[string]any) (map[string]any, error) {
	threadID := stringValue(payload, "threadId")
	turnID := stringValue(payload, "turnId")
	if threadID == "" || turnID == "" {
		return nil, errors.New("INTERRUPT_TURN missing threadId or turnId")
	}
	client, err := d.ensureCodex()
	if err != nil {
		return nil, err
	}
	_, err = client.request("turn/interrupt", map[string]any{"threadId": threadID, "turnId": turnID})
	return map[string]any{"interrupted": err == nil}, err
}

func (d *daemonRuntime) ensureCodex() (*rpcClient, error) {
	d.codexMu.Lock()
	defer d.codexMu.Unlock()
	if d.codex != nil && d.codex.cmd != nil && d.codex.cmd.Process != nil {
		return d.codex, nil
	}
	client, err := startCodex(d.server, d.id.NodeID, d.private, d.http)
	if err != nil {
		return nil, err
	}
	d.codex = client
	return client, nil
}

func startCodex(server, nodeID string, private ed25519.PrivateKey, httpClient *http.Client) (*rpcClient, error) {
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
		stdin: stdin, stdout: stdout, pending: make(map[string]chan rpcMessage), http: httpClient}
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
			go c.forwardNotification(method, message["params"])
		}
	}
}

func (c *rpcClient) forwardServerRequest(id any, message rpcMessage) {
	body, _ := json.Marshal(map[string]any{
		"requestId": id,
		"method":    message["method"],
		"params":    message["params"],
	})
	path := "/api/nodes/" + c.nodeID + "/codex/server-request"
	resp, err := signedHTTP(c.http, c.server, c.nodeID, c.private, http.MethodPost, path, body)
	if err != nil {
		_ = c.write(rpcMessage{"id": id, "error": map[string]any{"code": -32000, "message": safeError(err)}})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		_ = c.write(rpcMessage{"id": id, "error": map[string]any{"code": -32000, "message": strings.TrimSpace(string(data))}})
		return
	}
	var result any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		_ = c.write(rpcMessage{"id": id, "error": map[string]any{"code": -32000, "message": "invalid control-plane response"}})
		return
	}
	_ = c.write(rpcMessage{"id": id, "result": result})
}

func (c *rpcClient) forwardNotification(method string, params any) {
	body, _ := json.Marshal(map[string]any{"method": method, "params": params})
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

func fatal(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
