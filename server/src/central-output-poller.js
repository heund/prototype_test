const VALID_PATTERNS = new Set(["idle", "soft_burst", "active_burst"]);

const PWM_BY_PATTERN = {
  idle: 0,
  soft_burst: 102,
  active_burst: 204
};
const FETCH_TIMEOUT_MS = 5000;

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function validateCentralOutput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, status: "invalid", error: "output must be an object" };
  }

  if (value.target !== "fan") {
    return { ok: false, status: "invalid", error: "target must be fan" };
  }

  if (!VALID_PATTERNS.has(value.pattern)) {
    return { ok: false, status: "invalid", error: "unknown fan pattern" };
  }

  if (typeof value.intensity !== "number" || value.intensity < 0 || value.intensity > 1) {
    return { ok: false, status: "invalid", error: "intensity must be 0-1" };
  }

  if (typeof value.durationMs !== "number" || value.durationMs <= 0) {
    return { ok: false, status: "invalid", error: "durationMs must be positive" };
  }

  const generatedAtMs = Date.parse(value.generatedAt);
  if (Number.isNaN(generatedAtMs)) {
    return { ok: false, status: "invalid", error: "generatedAt must be a valid timestamp" };
  }

  return {
    ok: true,
    value: {
      target: "fan",
      pattern: value.pattern,
      intensity: value.intensity,
      durationMs: value.durationMs,
      generatedAt: value.generatedAt,
      generatedAtMs
    }
  };
}

function mapOutputToFanValue(output) {
  return PWM_BY_PATTERN[output.pattern] ?? 0;
}

function safeCentralOutput(output) {
  if (!output) return null;
  return {
    target: output.target,
    pattern: output.pattern,
    intensity: output.intensity,
    durationMs: output.durationMs,
    generatedAt: output.generatedAt
  };
}

function mergeCentralDiagnostics(state, updates) {
  return {
    ...state,
    centralOutput: Object.hasOwn(updates, "centralOutput") ? updates.centralOutput : state.centralOutput || null,
    centralStatus: updates.centralStatus || state.centralStatus || "not_configured",
    centralStopActive: Object.hasOwn(updates, "centralStopActive") ? updates.centralStopActive : Boolean(state.centralStopActive),
    pattern: updates.pattern || state.pattern || "idle",
    intensity: typeof updates.intensity === "number" ? updates.intensity : state.intensity || 0,
    expiresAt: Object.hasOwn(updates, "expiresAt") ? updates.expiresAt : state.expiresAt || null
  };
}

async function writeCentralState({ store, nodeId, centralStatus, centralOutput = null, pattern = "idle", intensity = 0, fans, mode, source = "central-server", expiresAt = null }) {
  const existing = await store.readState();
  const now = new Date().toISOString();
  const nextMode = mode || existing.mode || "central";

  const nextState = mergeCentralDiagnostics(existing, {
    centralOutput,
    centralStatus,
    pattern,
    intensity,
    expiresAt
  });

  nextState.nodeId = nodeId;
  nextState.mode = nextMode;
  nextState.source = source;
  nextState.updatedAt = now;
  nextState.updatedBy = source;

  if (fans) {
    nextState.fans = fans;
  }

  await store.writeState(nextState);
  return nextState;
}

async function applyCentralOutput({ store, nodeId, output, staleMs }) {
  const existing = await store.readState();
  const mode = existing.mode || "central";
  const nowMs = Date.now();
  const ageMs = nowMs - output.generatedAtMs;
  const expiresAt = new Date(output.generatedAtMs + output.durationMs).toISOString();
  const fanValue = mapOutputToFanValue(output);
  const centralOutput = safeCentralOutput(output);

  if (ageMs < 0 || ageMs > staleMs) {
    if (mode === "manual" || mode === "idle") {
      return writeCentralState({
        store,
        nodeId,
        mode,
        source: existing.source || "admin",
        centralStatus: "stale",
        centralOutput,
        pattern: "idle",
        intensity: 0,
        expiresAt
      });
    }

    return writeCentralState({
      store,
      nodeId,
      mode: "error",
      centralStatus: "stale",
      centralOutput,
      pattern: "idle",
      intensity: 0,
      fans: { fan1: 0 },
      expiresAt
    });
  }

  if (mode === "manual" || mode === "idle") {
    return writeCentralState({
      store,
      nodeId,
      mode,
      source: existing.source || "admin",
      centralStatus: "ok",
      centralOutput,
      pattern: output.pattern,
      intensity: output.intensity,
      expiresAt
    });
  }

  if (existing.centralStopActive) {
    return writeCentralState({
      store,
      nodeId,
      mode: "central",
      source: existing.source || "admin",
      centralStatus: "ok",
      centralOutput,
      pattern: output.pattern,
      intensity: output.intensity,
      fans: { fan1: 0 },
      expiresAt
    });
  }

  return writeCentralState({
    store,
    nodeId,
    mode: "central",
    centralStatus: "ok",
    centralOutput,
    pattern: output.pattern,
    intensity: output.intensity,
    fans: { fan1: fanValue },
    expiresAt
  });
}

async function applySafeOff({ store, nodeId, centralStatus, centralOutput = null }) {
  const existing = await store.readState();
  const mode = existing.mode || "central";

  if (mode === "manual" || mode === "idle") {
    return writeCentralState({
      store,
      nodeId,
      mode,
      source: existing.source || "admin",
      centralStatus,
      centralOutput,
      pattern: "idle",
      intensity: 0,
      expiresAt: null
    });
  }

  return writeCentralState({
    store,
    nodeId,
    mode: "error",
    centralStatus,
    centralOutput,
    pattern: "idle",
    intensity: 0,
    fans: { fan1: 0 },
    expiresAt: null
  });
}

export function createCentralOutputPoller({ store, nodeId, centralServerUrl, pollIntervalMs, staleMs }) {
  const baseUrl = normalizeBaseUrl(centralServerUrl);
  const intervalMs = parsePositiveInteger(pollIntervalMs, 2000);
  const outputStaleMs = parsePositiveInteger(staleMs, 10000);
  let timer = null;
  let stopped = false;

  async function pollOnce() {
    if (!baseUrl) {
      await applySafeOff({ store, nodeId, centralStatus: "not_configured" });
      return;
    }

    let timeout = null;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const response = await fetch(`${baseUrl}/api/outputs/fan`, {
        headers: { "Accept": "application/json" },
        signal: controller.signal
      });

      if (!response.ok) {
        await applySafeOff({ store, nodeId, centralStatus: "unreachable" });
        return;
      }

      const result = validateCentralOutput(await response.json());
      if (!result.ok) {
        await applySafeOff({ store, nodeId, centralStatus: result.status });
        return;
      }

      await applyCentralOutput({
        store,
        nodeId,
        output: result.value,
        staleMs: outputStaleMs
      });
    } catch {
      await applySafeOff({ store, nodeId, centralStatus: "unreachable" });
    } finally {
      clearTimeout(timeout);
    }
  }

  function scheduleNext() {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await pollOnce();
      } finally {
        scheduleNext();
      }
    }, intervalMs);
  }

  return {
    async start() {
      await pollOnce();
      scheduleNext();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    }
  };
}
