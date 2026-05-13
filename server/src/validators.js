export const FAN_KEYS = ["fan1"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateFans(value) {
  if (!isPlainObject(value)) {
    return { ok: false, error: "fans must be an object" };
  }

  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !FAN_KEYS.includes(key));
  if (unknown.length > 0) {
    return { ok: false, error: `unknown fan key: ${unknown[0]}` };
  }

  for (const key of FAN_KEYS) {
    if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 255) {
      return { ok: false, error: `${key} must be an integer from 0 to 255` };
    }
  }

  return {
    ok: true,
    value: FAN_KEYS.reduce((acc, key) => ({ ...acc, [key]: value[key] }), {})
  };
}

export function validateCommandPayload(body) {
  if (!isPlainObject(body)) {
    return { ok: false, error: "request body must be an object" };
  }

  if (body.mode !== "manual") {
    return { ok: false, error: "mode must be manual" };
  }

  const fans = validateFans(body.fans);
  if (!fans.ok) return fans;

  return {
    ok: true,
    value: {
      mode: "manual",
      fans: fans.value
    }
  };
}

export function validateHeartbeatPayload(body) {
  if (!isPlainObject(body)) {
    return { ok: false, error: "request body must be an object" };
  }

  const fans = validateFans(body.currentFans);
  if (!fans.ok) return { ok: false, error: `currentFans: ${fans.error}` };

  if (!Number.isInteger(body.wifiRssi) || body.wifiRssi > 0 || body.wifiRssi < -120) {
    return { ok: false, error: "wifiRssi must be an integer from -120 to 0" };
  }

  if (!Number.isInteger(body.uptimeMs) || body.uptimeMs < 0) {
    return { ok: false, error: "uptimeMs must be a non-negative integer" };
  }

  return {
    ok: true,
    value: {
      currentFans: fans.value,
      wifiRssi: body.wifiRssi,
      uptimeMs: body.uptimeMs
    }
  };
}

export function sanitizeLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(500, parsed));
}
