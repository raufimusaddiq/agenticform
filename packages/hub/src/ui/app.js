// Hub Operator UI. The bearer token lives in sessionStorage and only ever
// travels in the Authorization header: never in a URL, the DOM, or a log line.
const $ = (id) => document.getElementById(id)

// State management
const state = {
  token: sessionStorage.getItem("af.token") ?? "",
  role: "unknown", // "admin" | "caller" | "unknown"
  runId: null,
  stream: null,
  highestSeq: 0,
  runs: loadStoredRuns(),
  autoScroll: true,
  dropped: 0,
}

// The log keeps the newest lines only; highestSeq still tracks the true tail so resume works.
const MAX_EVENT_LINES = 1000

function loadStoredRuns() {
  try {
    const raw = sessionStorage.getItem("af.recent_runs")
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveStoredRuns() {
  try {
    sessionStorage.setItem("af.recent_runs", JSON.stringify(state.runs.slice(0, 50)))
  } catch {}
}

// harnesses holds only the ready (advertised) ids; missing, unauthenticated and
// unknown ones appear only in harnessReport. Show the union: ready first, then
// the rest, each group by id. An id without a report entry predates the report
// field and counts as ready; a report entry keeps its own status either way.
// harnessChipModels:start
function harnessChipModels(node) {
  const report = new Map()
  if (Array.isArray(node.harnessReport)) {
    for (const r of node.harnessReport) {
      if (r && typeof r.id === "string") report.set(r.id, r)
    }
  }
  const ids = new Set(Array.isArray(node.harnesses) ? node.harnesses.filter((h) => typeof h === "string") : [])
  for (const id of report.keys()) ids.add(id)
  const models = [...ids].map((id) => {
    const r = report.get(id)
    const status = typeof r?.status === "string" && r.status ? r.status : "ready"
    const reason = typeof r?.reason === "string" ? r.reason : ""
    return { id, status, reason }
  })
  const rank = (m) => (m.status === "ready" ? 0 : 1)
  return models.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
// harnessChipModels:end

// Safe DOM builder: text only goes in as text nodes, never parsed as markup
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, val] of Object.entries(attrs)) {
    if (val === null || val === undefined) continue
    if (key === "style") continue // inline styles are blocked by the CSP; use classes
    if (key === "className") {
      node.className = val
    } else if (key.startsWith("on") && typeof val === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), val)
    } else if (key === "dataset" && typeof val === "object") {
      Object.assign(node.dataset, val)
    } else if (typeof val === "boolean") {
      if (val) node.setAttribute(key, "")
    } else {
      node.setAttribute(key, String(val))
    }
  }
  const childList = Array.isArray(children) ? children : [children]
  for (const child of childList) {
    if (child === null || child === undefined) continue
    if (typeof child === "string" || typeof child === "number") {
      node.appendChild(document.createTextNode(String(child)))
    } else if (child instanceof Node) {
      node.appendChild(child)
    }
  }
  return node
}

function formatRelativeTime(isoString) {
  if (!isoString) return "never"
  const date = new Date(isoString)
  const diffSec = Math.round((Date.now() - date.getTime()) / 1000)
  if (isNaN(diffSec)) return isoString
  if (diffSec < 5) return "just now"
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  return date.toLocaleDateString()
}

function setError(message) {
  const banner = $("error")
  const text = $("error-message")
  if (message) {
    text.textContent = message
    banner.hidden = false
  } else {
    text.textContent = ""
    banner.hidden = true
  }
}

function show(view) {
  for (const name of ["machines", "runs", "run", "tokens"]) {
    const section = $("view-" + name)
    if (section) section.hidden = name !== view
  }
  for (const btn of document.querySelectorAll("nav button")) {
    btn.classList.toggle("active", btn.dataset.view === view)
  }
}

async function api(path, options = {}) {
  const headers = { authorization: `Bearer ${state.token}` }
  if (options.body !== undefined) headers["content-type"] = "application/json"
  const response = await fetch(path, { ...options, headers })
  const body = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    const msg = body?.error?.message ?? `HTTP ${response.status}`
    const code = body?.error?.code
    const err = new Error(code ? `[${code}] ${msg}` : msg)
    err.status = response.status
    err.code = code
    throw err
  }
  return body
}

// Check role by querying tokens endpoint
async function probeRole() {
  if (!state.token) {
    state.role = "unknown"
    updateRoleIndicator()
    return
  }
  if (state.token.startsWith("afc_")) {
    state.role = "caller"
    updateRoleIndicator()
    return
  }
  try {
    await api("/v1/tokens")
    state.role = "admin"
  } catch (err) {
    if (err.status === 403) {
      state.role = "caller"
    } else {
      state.role = "admin"
    }
  }
  updateRoleIndicator()
}

function updateRoleIndicator() {
  const pill = $("connection-pill")
  const label = $("connection-label")
  const tokensPill = $("tokens-role-pill")
  const adminNotice = $("tokens-admin-notice")

  pill.className = "connection-pill"
  if (!state.token) {
    pill.classList.add("disconnected")
    label.textContent = "Disconnected"
    if (tokensPill) tokensPill.textContent = "Admin"
    return
  }

  if (state.role === "admin") {
    pill.classList.add("connected-admin")
    label.textContent = "Connected (Admin)"
    if (tokensPill) tokensPill.textContent = "Admin"
    if (adminNotice) adminNotice.hidden = true
  } else {
    pill.classList.add("connected-caller")
    label.textContent = "Connected (Caller)"
    if (tokensPill) tokensPill.textContent = "Caller"
    if (adminNotice) adminNotice.hidden = false
  }
}

// -------------------------------------------------------------
// MACHINES
// -------------------------------------------------------------
async function loadMachines() {
  setError("")
  try {
    const { nodes } = await api("/v1/nodes")
    const body = $("machines-body")
    body.replaceChildren()

    let totalSlots = 0
    let totalInUse = 0
    let onlineCount = 0

    for (const node of nodes) {
      totalSlots += node.capacity.slots
      totalInUse += node.capacity.inUse
      if (node.status === "online" || node.status === "active") onlineCount++

      const row = el("tr")

      // 1. Node name & ID
      const nameCol = el("td", {}, [
        el("div", { className: "cell-strong" }, node.name),
        el("div", { className: "summary-text mono-small" }, [
          node.nodeId.slice(0, 12) + "...",
          el("span", { className: "tab-pill pill-gap" }, `v${node.protocolVersion}`),
        ]),
      ])

      // 2. Status badge
      const statusClass = `badge badge-${node.status}`
      const statusCol = el("td", {}, [
        el("span", { className: statusClass }, node.status),
      ])

      // 3. Harnesses with report status & reason
      const harnessChips = el("div", { className: "harness-list" })
      for (const { id, status, reason } of harnessChipModels(node)) {
        const detail = reason ? `: ${reason}` : ""
        harnessChips.appendChild(
          el("span", { className: `badge badge-${status}`, title: `${id} status: ${status}${detail}` }, [
            el("span", { className: "cell-strong" }, id),
            el("span", { className: "chip-detail" }, ` (${status}${detail})`),
          ])
        )
      }
      const harnessCol = el("td", {}, harnessChips)

      // 4. Isolation mode and self-test
      let isoDesc = "none"
      let isoClass = "badge badge-neutral"
      if (node.isolation) {
        const mode = node.isolation.mode ?? "unknown"
        const test = node.isolation.selfTest ? ` (self-test: ${node.isolation.selfTest})` : ""
        isoDesc = `${mode}${test}`
        isoClass = node.isolation.selfTest === "pass" ? "badge badge-ready" : "badge badge-neutral"
      }
      const isoCol = el("td", {}, [
        el("span", { className: isoClass }, isoDesc),
      ])

      // 5. Capacity meter
      const pct = node.capacity.slots > 0 ? Math.round((node.capacity.inUse / node.capacity.slots) * 100) : 0
      // CSSOM writes are allowed by the CSP; an inline style attribute is not.
      const fill = el("div", { className: "capacity-fill" })
      fill.style.width = `${pct}%`
      const capCol = el("td", {}, [
        el("div", { className: "capacity-meter" }, [
          el("div", { className: "capacity-bar" }, [fill]),
          el("span", { className: "mono-small" }, `${node.capacity.inUse}/${node.capacity.slots}`),
        ]),
      ])

      // 6. Last heartbeat
      const hbTime = formatRelativeTime(node.lastHeartbeatAt)
      const hbCol = el("td", { title: node.lastHeartbeatAt ?? "never" }, hbTime)

      // 7. Actions (Disable / Revoke)
      const actionsCol = el("td", { className: "text-right" })
      if (node.status !== "revoked") {
        const disableBtn = el(
          "button",
          {
            type: "button",
            className: "btn btn-ghost btn-sm",
            onClick: async () => {
              if (confirm(`Disable node ${node.name}? Active runs will be disconnected.`)) {
                try {
                  await api(`/v1/nodes/${encodeURIComponent(node.nodeId)}/disable`, { method: "POST" })
                  loadMachines()
                } catch (e) {
                  setError(e.message)
                }
              }
            },
          },
          "Disable"
        )
        actionsCol.appendChild(disableBtn)
      }

      row.append(nameCol, statusCol, harnessCol, isoCol, capCol, hbCol, actionsCol)
      body.append(row)
    }

    const countBadge = $("machines-count")
    if (countBadge) countBadge.textContent = String(nodes.length)
    const summary = $("machines-summary")
    if (summary) summary.textContent = `${onlineCount}/${nodes.length} online · ${totalInUse}/${totalSlots} capacity slots in use`
  } catch (error) {
    setError(error.message)
  }
}

// -------------------------------------------------------------
// RUNS
// -------------------------------------------------------------
function renderRuns() {
  const list = $("runs-list")
  list.replaceChildren()

  const countBadge = $("runs-count")
  if (countBadge) countBadge.textContent = String(state.runs.length)

  if (state.runs.length === 0) {
    list.appendChild(
      el("li", { className: "empty-note" }, [
        "No runs in this session yet. Launch a run or enter a run ID above.",
      ])
    )
    return
  }

  for (const item of state.runs) {
    const runId = typeof item === "string" ? item : item.runId
    const harness = typeof item === "object" ? item.harness : "codex"
    const status = typeof item === "object" ? item.status : "unknown"
    const prompt = typeof item === "object" && item.prompt ? item.prompt.slice(0, 70) + (item.prompt.length > 70 ? "..." : "") : ""

    const btn = el(
      "button",
      {
        type: "button",
        className: "run-item-btn",
        onClick: () => openRun(runId),
      },
      [
        el("div", {}, [
          el("div", { className: "run-item-id" }, runId),
          prompt ? el("div", { className: "run-item-meta" }, prompt) : null,
        ]),
        el("div", { className: "run-item-tags" }, [
          el("span", { className: "tab-pill" }, harness),
          status !== "unknown" ? el("span", { className: `badge badge-${status}` }, status) : null,
          el("span", { className: "run-item-arrow", "aria-hidden": "true" }, "→"),
        ]),
      ]
    )

    const li = el("li", {}, btn)
    list.append(li)
  }
}

function updateRecentRun(run) {
  const idx = state.runs.findIndex((r) => (typeof r === "string" ? r === run.runId : r.runId === run.runId))
  const entry = {
    runId: run.runId,
    status: run.status,
    harness: run.harness ?? (idx >= 0 && typeof state.runs[idx] === "object" ? state.runs[idx].harness : "codex"),
    prompt: run.prompt ?? (idx >= 0 && typeof state.runs[idx] === "object" ? state.runs[idx].prompt : ""),
    createdAt: run.createdAt ?? new Date().toISOString(),
  }
  if (idx >= 0) {
    state.runs[idx] = entry
  } else {
    state.runs.unshift(entry)
  }
  saveStoredRuns()
  renderRuns()
}

// -------------------------------------------------------------
// RUN VIEW
// -------------------------------------------------------------
function renderRun(run) {
  $("run-id").textContent = run.runId
  $("run-status").textContent = run.status
  $("run-status").className = `status-pill badge-${run.status}`

  const nodeInfo = $("run-node-info")
  if (nodeInfo) nodeInfo.textContent = run.nodeId ? `Node: ${run.nodeId}` : "Node: Unassigned"
  const genInfo = $("run-gen-info")
  if (genInfo) genInfo.textContent = `Gen: ${run.generation ?? 1}`

  const errCard = $("run-error-card")
  const errText = $("run-error-text")
  const resCard = $("run-result-card")
  const resText = $("run-result")

  if (run.error) {
    if (errCard) errCard.hidden = false
    if (errText) errText.textContent = `${run.error.code}: ${run.error.message}`
  } else {
    if (errCard) errCard.hidden = true
    if (errText) errText.textContent = ""
  }

  if (run.result !== undefined && run.result !== null) {
    if (resCard) resCard.hidden = false
    if (resText) {
      resText.textContent = typeof run.result === "string" ? run.result : JSON.stringify(run.result, null, 2)
    }
  } else {
    if (resCard) resCard.hidden = true
    if (resText) resText.textContent = ""
  }

  const isTerminal = ["completed", "failed", "cancelled"].includes(run.status)
  $("cancel-run").disabled = isTerminal

  updateRecentRun(run)
}

function appendEvent(event) {
  if (event.seq > state.highestSeq) state.highestSeq = event.seq

  const eventsList = $("events")
  const item = el("li", { className: "event-entry" })

  // Sequence
  const seqSpan = el("span", { className: "event-seq" }, `#${event.seq}`)

  // Time
  const when = event.at ? new Date(event.at) : null
  const timeStr = when && !isNaN(when.getTime())
    ? when.toTimeString().slice(0, 8) + "." + String(when.getMilliseconds()).padStart(3, "0")
    : ""
  const timeSpan = el("span", { className: "event-time" }, timeStr)

  // Type badge
  let typeCategory = "general"
  if (event.type.startsWith("message.")) typeCategory = "message"
  else if (event.type.startsWith("permission.")) typeCategory = "permission"
  else if (event.type === "run.finished") typeCategory = "finished"

  const typeBadge = el("span", { className: `event-type-badge event-type-${typeCategory}` }, event.type)

  // Data content
  let dataNode
  if (event.type === "message.delta" && event.data?.text) {
    dataNode = el("div", { className: "event-data event-message-text" }, event.data.text)
  } else {
    dataNode = el("div", { className: "event-data" }, JSON.stringify(event.data))
  }

  item.append(seqSpan, timeSpan, typeBadge, dataNode)
  eventsList.append(item)
  while (eventsList.children.length > MAX_EVENT_LINES) {
    eventsList.firstElementChild.remove()
    state.dropped++
  }

  const countElem = $("events-count")
  if (countElem) {
    countElem.textContent = `${eventsList.children.length} events` +
      (state.dropped > 0 ? ` (${state.dropped} older dropped, newest ${MAX_EVENT_LINES} kept)` : "")
  }

  if (state.autoScroll) {
    eventsList.scrollTop = eventsList.scrollHeight
  }

  // A permission event changes the pending list, so refresh it
  if (event.type.startsWith("permission.") && state.runId) {
    loadPermissions(state.runId)
  }
}

// Pending requests with Allow and Deny.
async function loadPermissions(runId) {
  try {
    const { permissions } = await api(`/v1/runs/${encodeURIComponent(runId)}/permissions`)
    const list = $("permissions")
    list.replaceChildren()

    const pending = permissions.filter((p) => p.status === "pending")
    const badge = $("permissions-badge")
    if (badge) badge.textContent = `${pending.length} pending`

    if (permissions.length === 0) {
      list.appendChild(
        el("li", { className: "empty-note" }, "No permission requests for this run.")
      )
      return
    }

    for (const permission of permissions) {
      const isPending = permission.status === "pending"
      const item = el("li", { className: "permission-item" })

      const titleText = permission.title || `Request ${permission.requestId}`
      const infoNode = el("div", { className: "permission-info" }, [
        el("div", { className: "permission-title" }, titleText),
        el("div", { className: "permission-meta" }, [
          el("span", { className: "mono-small" }, permission.requestId),
          permission.kind ? el("span", { className: "tab-pill pill-gap" }, permission.kind) : null,
          el("span", { className: `badge badge-${permission.status} pill-gap` }, permission.status),
          permission.by === "policy"
            ? el("span", { className: "tab-pill pill-gap" }, `policy: ${permission.decision ?? "?"}`)
            : null,
        ]),
      ])

      const actionsNode = el("div", { className: "permission-actions" })
      if (isPending) {
        const allowBtn = el(
          "button",
          {
            type: "button",
            className: "btn btn-success btn-sm",
            onClick: () => answerPermission(permission.requestId, "allow"),
          },
          "✓ Allow"
        )
        const denyBtn = el(
          "button",
          {
            type: "button",
            className: "btn btn-danger btn-sm",
            onClick: () => answerPermission(permission.requestId, "deny"),
          },
          "✕ Deny"
        )
        actionsNode.append(allowBtn, denyBtn)
      }

      item.append(infoNode, actionsNode)
      list.append(item)
    }
  } catch (error) {
    setError(error.message)
  }
}

async function answerPermission(requestId, decision) {
  if (!state.runId) return
  setError("")
  try {
    await api(
      `/v1/runs/${encodeURIComponent(state.runId)}/permissions/${encodeURIComponent(requestId)}`,
      { method: "POST", body: JSON.stringify({ decision }) }
    )
    await loadPermissions(state.runId)
  } catch (error) {
    if (error.status === 403 || error.code === "forbidden") {
      setError("Answering requires the admin token")
    } else {
      setError(error.message)
    }
  }
}

async function openRun(runId) {
  state.runId = runId
  state.highestSeq = 0
  state.dropped = 0
  state.stream?.abort()
  $("events").replaceChildren()
  $("permissions").replaceChildren()
  show("run")
  setError("")

  try {
    const run = await api(`/v1/runs/${encodeURIComponent(runId)}`)
    renderRun(run)
  } catch (error) {
    setError(error.message)
    return
  }

  loadPermissions(runId)
  streamEvents(runId, 0)
}

// Fetch-SSE streaming with resume support
async function streamEvents(runId, after = 0) {
  const controller = new AbortController()
  state.stream = controller

  const streamPill = $("stream-status-pill")
  if (streamPill) {
    streamPill.className = "stream-pill live"
    streamPill.replaceChildren(el("span", { className: "stream-dot" }), " LIVE")
  }

  try {
    const response = await fetch(
      `/v1/runs/${encodeURIComponent(runId)}/events?stream=sse&after=${after}`,
      {
        headers: { authorization: `Bearer ${state.token}` },
        signal: controller.signal,
      }
    )
    if (!response.ok || !response.body) throw new Error(`Stream connection failed: HTTP ${response.status}`)

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let split
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue
          try {
            const event = JSON.parse(line.slice(6))
            appendEvent(event)
          } catch {}
        }
      }
    }

    // Refresh final run state when stream closes
    renderRun(await api(`/v1/runs/${encodeURIComponent(runId)}`))
  } catch (error) {
    if (error.name !== "AbortError") {
      setError(error.message)
      if (streamPill) {
        streamPill.className = "stream-pill paused"
        streamPill.replaceChildren(el("span", { className: "stream-dot" }), " PAUSED")
      }
    }
  }
}

async function createRun(form) {
  setError("")
  const data = new FormData(form)
  const harness = data.get("harness")
  const prompt = data.get("prompt")
  const requiresRaw = data.get("requires")
  const nodeId = data.get("nodeId")

  const payload = {
    idempotencyKey: crypto.randomUUID(),
    harness,
    prompt,
  }
  if (requiresRaw) {
    payload.requires = requiresRaw.split(",").map((s) => s.trim()).filter(Boolean)
  }
  if (nodeId) payload.nodeId = nodeId.trim()
  const permissionPolicy = data.get("permissionPolicy")
  if (permissionPolicy) payload.permissionPolicy = permissionPolicy

  try {
    const run = await api("/v1/runs", {
      method: "POST",
      body: JSON.stringify(payload),
    })
    const entry = {
      runId: run.runId,
      status: run.status,
      harness,
      prompt,
      createdAt: run.createdAt ?? new Date().toISOString(),
    }
    state.runs.unshift(entry)
    saveStoredRuns()
    renderRuns()
    form.reset()
    if ($("run-harness")) $("run-harness").value = "codex"
    openRun(run.runId)
  } catch (error) {
    setError(error.message)
  }
}

async function cancelRun() {
  if (!state.runId) return
  setError("")
  try {
    renderRun(await api(`/v1/runs/${encodeURIComponent(state.runId)}/cancel`, { method: "POST" }))
  } catch (error) {
    setError(error.message)
  }
}

// -------------------------------------------------------------
// TOKENS (CALLER TOKEN MANAGEMENT)
// -------------------------------------------------------------
async function loadTokens() {
  setError("")
  try {
    const { tokens } = await api("/v1/tokens")
    state.role = "admin"
    updateRoleIndicator()
    const body = $("tokens-body")
    body.replaceChildren()

    if (!tokens || tokens.length === 0) {
      body.appendChild(
        el("tr", {}, [
          el("td", { colSpan: 6, className: "empty-note" }, "No caller tokens issued yet."),
        ])
      )
      return
    }

    for (const token of tokens) {
      const isRevoked = token.revokedAt !== null
      const row = el("tr")

      const nameCol = el("td", { className: "cell-strong" }, token.name)
      const idCol = el("td", { className: "mono-small" }, token.id)
      const createdCol = el("td", { title: token.createdAt }, formatRelativeTime(token.createdAt))
      const lastUsedCol = el("td", { title: token.lastUsedAt ?? "never" }, formatRelativeTime(token.lastUsedAt))

      const statusBadge = isRevoked ? el("span", { className: "badge badge-revoked" }, "Revoked") : el("span", { className: "badge badge-active" }, "Active")
      const statusCol = el("td", {}, statusBadge)

      const actionsCol = el("td", { className: "text-right" })
      if (!isRevoked) {
        const revokeBtn = el(
          "button",
          {
            type: "button",
            className: "btn btn-danger btn-sm",
            onClick: async () => {
              if (confirm(`Revoke token "${token.name}"? Callers will immediately lose access.`)) {
                try {
                  await api(`/v1/tokens/${encodeURIComponent(token.id)}/revoke`, { method: "POST" })
                  loadTokens()
                } catch (e) {
                  setError(e.message)
                }
              }
            },
          },
          "Revoke"
        )
        actionsCol.appendChild(revokeBtn)
      }

      row.append(nameCol, idCol, createdCol, lastUsedCol, statusCol, actionsCol)
      body.append(row)
    }
  } catch (error) {
    if (error.status === 403) {
      state.role = "caller"
      updateRoleIndicator()
      const body = $("tokens-body")
      body.replaceChildren(
        el("tr", {}, [
          el("td", { colSpan: 6, className: "empty-note" }, "Admin token required to manage caller tokens."),
        ])
      )
    } else {
      setError(error.message)
    }
  }
}

async function issueToken(form) {
  setError("")
  const data = new FormData(form)
  const name = data.get("name")
  try {
    const res = await api("/v1/tokens", {
      method: "POST",
      body: JSON.stringify({ name, scope: "runs" }),
    })
    form.reset()
    const panel = $("issued-token-panel")
    const secretElem = $("issued-token-secret")
    if (panel && secretElem) {
      secretElem.textContent = res.token
      panel.hidden = false
    }
    loadTokens()
  } catch (error) {
    setError(error.message)
  }
}

// -------------------------------------------------------------
// CONNECTION & INITIALIZATION
// -------------------------------------------------------------
async function connect() {
  const signedIn = state.token.length > 0
  const loginModal = $("login-modal")
  const signOutBtn = $("sign-out")

  if (loginModal) loginModal.hidden = signedIn
  if (signOutBtn) signOutBtn.hidden = !signedIn

  if (!signedIn) {
    updateRoleIndicator()
    show("machines")
    $("view-machines").hidden = true
    return
  }

  show("machines")
  await probeRole()
  loadMachines()
  renderRuns()
}

// Event Listeners
$("token-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  state.token = $("token").value.trim()
  $("token").value = ""
  sessionStorage.setItem("af.token", state.token)
  await connect()
})

$("sign-out").addEventListener("click", () => {
  state.token = ""
  state.role = "unknown"
  state.stream?.abort()
  state.runs = []
  state.runId = null
  sessionStorage.removeItem("af.token")
  sessionStorage.removeItem("af.recent_runs")
  connect()
})

for (const button of document.querySelectorAll("nav button")) {
  button.addEventListener("click", () => {
    const view = button.dataset.view
    show(view)
    if (view === "machines") loadMachines()
    if (view === "runs") renderRuns()
    if (view === "tokens") loadTokens()
  })
}

$("refresh-machines").addEventListener("click", loadMachines)
$("run-form").addEventListener("submit", (event) => {
  event.preventDefault()
  createRun(event.target)
})
$("open-form").addEventListener("submit", (event) => {
  event.preventDefault()
  openRun(new FormData(event.target).get("runId").trim())
})
$("cancel-run").addEventListener("click", cancelRun)
$("back-runs").addEventListener("click", () => {
  state.stream?.abort()
  show("runs")
  renderRuns()
})

const resumeBtn = $("resume-stream")
if (resumeBtn) {
  resumeBtn.addEventListener("click", () => {
    if (state.runId) {
      state.stream?.abort()
      streamEvents(state.runId, state.highestSeq)
    }
  })
}

const autoscrollCheck = $("autoscroll-toggle")
if (autoscrollCheck) {
  autoscrollCheck.addEventListener("change", (e) => {
    state.autoScroll = e.target.checked
  })
}

const clearEventsBtn = $("clear-events-view")
if (clearEventsBtn) {
  clearEventsBtn.addEventListener("click", () => {
    $("events").replaceChildren()
  })
}

const dismissErrBtn = $("dismiss-error")
if (dismissErrBtn) {
  dismissErrBtn.addEventListener("click", () => setError(""))
}

const issueForm = $("issue-token-form")
if (issueForm) {
  issueForm.addEventListener("submit", (event) => {
    event.preventDefault()
    issueToken(event.target)
  })
}

const refreshTokensBtn = $("refresh-tokens")
if (refreshTokensBtn) {
  refreshTokensBtn.addEventListener("click", loadTokens)
}

const copyTokenBtn = $("copy-token-btn")
if (copyTokenBtn) {
  copyTokenBtn.addEventListener("click", () => {
    const text = $("issued-token-secret").textContent
    if (text) {
      navigator.clipboard.writeText(text).then(() => {
        const orig = copyTokenBtn.textContent
        copyTokenBtn.textContent = "Copied!"
        setTimeout(() => {
          copyTokenBtn.textContent = orig
        }, 2000)
      })
    }
  })
}

// Color Theme Management
const themeToggle = $("theme-toggle")
if (themeToggle) {
  const savedTheme = localStorage.getItem("af.theme")
  if (savedTheme) {
    document.documentElement.dataset.theme = savedTheme
  }
  themeToggle.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme
    const next = current === "dark" ? "light" : "dark"
    document.documentElement.dataset.theme = next
    localStorage.setItem("af.theme", next)
  })
}

connect()
