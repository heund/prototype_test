import express from "express";
import { requireBearerToken } from "./auth.js";
import {
  FAN_KEYS,
  sanitizeLimit,
  validateCommandPayload,
  validateHeartbeatPayload
} from "./validators.js";

const adminHtml = String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Fan Control</title>
</head>
<body>
  <h1>Fan Control</h1>

  <p>
    Admin token:
    <input id="token" type="password" size="60">
  </p>

  <p>
    <button data-fan="0">STOP</button>
    <button data-fan="64">LOW</button>
    <button data-fan="128">MEDIUM</button>
    <button data-fan="255">HIGH</button>
  </p>

  <h2>Status</h2>
  <pre id="status">Enter token, then press a button.</pre>

  <h2>Logs</h2>
  <pre id="logs"></pre>

  <script src="/admin.js"></script>
</body>
</html>`;

const adminJs = String.raw`function token() {
  return document.getElementById("token").value.trim();
}

function authHeaders() {
  return {
    "Authorization": "Bearer " + token(),
    "Content-Type": "application/json"
  };
}

async function request(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: {
      ...authHeaders(),
      ...(options && options.headers ? options.headers : {})
    }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Request failed");
  return body;
}

async function sendFan(value) {
  try {
    await request("/api/admin/command", {
      method: "POST",
      body: JSON.stringify({
        mode: "manual",
        fans: { fan1: value }
      })
    });
    await refresh();
  } catch (err) {
    document.getElementById("status").textContent = err.message;
  }
}

async function refresh() {
  if (!token()) return;
  const state = await request("/api/admin/state");
  const logs = await request("/api/admin/logs?limit=50");
  document.getElementById("status").textContent = JSON.stringify(state, null, 2);
  document.getElementById("logs").textContent = logs.logs
    .map((entry) => JSON.stringify(entry))
    .join("\n");
}

document.querySelectorAll("[data-fan]").forEach((button) => {
  button.addEventListener("click", () => sendFan(Number(button.dataset.fan)));
});
document.getElementById("token").addEventListener("change", refresh);
setInterval(() => refresh().catch(() => {}), 5000);
`;

export function createRoutes({ store, nodeId, adminToken, deviceToken }) {
  const router = express.Router();
  const requireAdmin = requireBearerToken({
    expectedToken: adminToken,
    source: "admin",
    logEvent: (entry) => store.appendLog(entry)
  });
  const requireDevice = requireBearerToken({
    expectedToken: deviceToken,
    source: "device",
    logEvent: (entry) => store.appendLog(entry)
  });

  router.get("/health", (_req, res) => {
    res.json({ ok: true, service: "fan-control-test" });
  });

  router.get("/admin", (_req, res) => {
    res.type("html").send(adminHtml);
  });

  router.get("/admin.js", (_req, res) => {
    res.type("application/javascript").send(adminJs);
  });

  router.get("/api/admin/state", requireAdmin, async (_req, res) => {
    const state = await store.readState();
    const lastHeartbeat = await store.readLastHeartbeat();
    res.json({ state, lastHeartbeat });
  });

  router.post("/api/admin/command", requireAdmin, async (req, res) => {
    const result = validateCommandPayload(req.body);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    const state = {
      nodeId,
      mode: result.value.mode,
      fans: result.value.fans,
      updatedAt: new Date().toISOString(),
      updatedBy: "admin"
    };

    await store.writeState(state);
    await store.appendLog({
      source: "admin",
      nodeId,
      event: "COMMAND_SET",
      data: {
        fans: state.fans,
        mode: state.mode
      }
    });

    res.json({ ok: true, state });
  });

  router.get("/api/admin/logs", requireAdmin, async (req, res) => {
    const limit = sanitizeLimit(req.query.limit);
    const logs = await store.readRecentLogs(limit);
    res.json({ logs });
  });

  router.get("/api/device/:nodeId/state", requireDevice, async (req, res) => {
    if (req.params.nodeId !== nodeId) {
      return res.status(404).json({ error: "Unknown node" });
    }

    const state = await store.readState();
    await store.appendLog({
      source: "device",
      nodeId,
      event: "STATE_POLLED",
      data: {}
    });

    res.json({
      nodeId: state.nodeId,
      fans: FAN_KEYS.reduce((acc, key) => ({ ...acc, [key]: state.fans[key] }), {}),
      updatedAt: state.updatedAt
    });
  });

  router.post("/api/device/:nodeId/heartbeat", requireDevice, async (req, res) => {
    if (req.params.nodeId !== nodeId) {
      return res.status(404).json({ error: "Unknown node" });
    }

    const result = validateHeartbeatPayload(req.body);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    const heartbeat = {
      time: new Date().toISOString(),
      nodeId,
      ...result.value
    };

    await store.writeLastHeartbeat(heartbeat);
    await store.appendLog({
      source: "device",
      nodeId,
      event: "HEARTBEAT",
      data: heartbeat
    });

    res.json({ ok: true });
  });

  return router;
}
