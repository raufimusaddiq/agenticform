// Hub UI. The bearer token lives in sessionStorage and only ever travels in the
// Authorization header: never in a URL, the DOM, or a log line.
const $ = (id) => document.getElementById(id)
const state = { token: sessionStorage.getItem("af.token") ?? "", runId: null, stream: null, runs: [] }

function setError(message) {
  const node = $("error")
  node.textContent = message ?? ""
  node.hidden = !message
}

function show(view) {
  for (const name of ["machines", "runs", "run"]) $("view-" + name).hidden = name !== view
}

async function api(path, options = {}) {
  const headers = { authorization: `Bearer ${state.token}` }
  if (options.body !== undefined) headers["content-type"] = "application/json"
  const response = await fetch(path, { ...options, headers })
  const body = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`)
  return body
}

function cell(row, text) {
  const td = document.createElement("td")
  td.textContent = text
  row.append(td)
}

async function loadMachines() {
  setError("")
  try {
    const { nodes } = await api("/v1/nodes")
    const body = $("machines-body")
    body.replaceChildren()
    for (const node of nodes) {
      const row = document.createElement("tr")
      cell(row, node.name)
      cell(row, node.status)
      cell(row, node.harnesses.join(", "))
      cell(row, `${node.capacity.inUse}/${node.capacity.slots}`)
      cell(row, node.lastHeartbeatAt ?? "never")
      body.append(row)
    }
  } catch (error) {
    setError(error.message)
  }
}

function renderRuns() {
  const list = $("runs-list")
  list.replaceChildren()
  for (const runId of state.runs) {
    const item = document.createElement("li")
    const button = document.createElement("button")
    button.type = "button"
    button.textContent = runId
    button.addEventListener("click", () => openRun(runId))
    item.append(button)
    list.append(item)
  }
}

function renderRun(run) {
  $("run-id").textContent = run.runId
  $("run-status").textContent = run.status
  $("run-result").textContent = run.error
    ? `${run.error.code}: ${run.error.message}`
    : run.result === undefined
      ? ""
      : JSON.stringify(run.result)
  $("cancel-run").disabled = ["completed", "failed", "cancelled"].includes(run.status)
}

function appendEvent(event) {
  const item = document.createElement("li")
  item.textContent = `${event.seq} ${event.at} ${event.type} ${JSON.stringify(event.data)}`
  $("events").append(item)
}

async function openRun(runId) {
  state.runId = runId
  state.stream?.abort()
  $("events").replaceChildren()
  show("run")
  setError("")
  try {
    renderRun(await api(`/v1/runs/${encodeURIComponent(runId)}`))
  } catch (error) {
    setError(error.message)
    return
  }
  streamEvents(runId)
}

// The browser's event-source API cannot send an Authorization header, so the
// stream is read with fetch and parsed here. The token stays in the header.
async function streamEvents(runId) {
  const controller = new AbortController()
  state.stream = controller
  try {
    const response = await fetch(`/v1/runs/${encodeURIComponent(runId)}/events?stream=sse&after=0`, {
      headers: { authorization: `Bearer ${state.token}` },
      signal: controller.signal,
    })
    if (!response.ok || !response.body) throw new Error(`stream failed: HTTP ${response.status}`)
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
          appendEvent(JSON.parse(line.slice(6)))
        }
      }
    }
    renderRun(await api(`/v1/runs/${encodeURIComponent(runId)}`))
  } catch (error) {
    if (error.name !== "AbortError") setError(error.message)
  }
}

async function createRun(form) {
  setError("")
  const data = new FormData(form)
  try {
    const run = await api("/v1/runs", {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        harness: data.get("harness"),
        prompt: data.get("prompt"),
      }),
    })
    state.runs.unshift(run.runId)
    renderRuns()
    form.reset()
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

function connect() {
  const signedIn = state.token.length > 0
  $("token-form").hidden = signedIn
  $("sign-out").hidden = !signedIn
  if (!signedIn) {
    show("machines")
    $("view-machines").hidden = true
    return
  }
  show("machines")
  loadMachines()
}

$("token-form").addEventListener("submit", (event) => {
  event.preventDefault()
  state.token = $("token").value
  $("token").value = ""
  sessionStorage.setItem("af.token", state.token)
  connect()
})

$("sign-out").addEventListener("click", () => {
  state.token = ""
  state.stream?.abort()
  sessionStorage.removeItem("af.token")
  connect()
})

for (const button of document.querySelectorAll("nav button")) {
  button.addEventListener("click", () => {
    show(button.dataset.view)
    if (button.dataset.view === "machines") loadMachines()
    if (button.dataset.view === "runs") renderRuns()
  })
}

$("refresh-machines").addEventListener("click", loadMachines)
$("run-form").addEventListener("submit", (event) => {
  event.preventDefault()
  createRun(event.target)
})
$("open-form").addEventListener("submit", (event) => {
  event.preventDefault()
  openRun(new FormData(event.target).get("runId"))
})
$("cancel-run").addEventListener("click", cancelRun)
$("back-runs").addEventListener("click", () => {
  state.stream?.abort()
  show("runs")
  renderRuns()
})

connect()
