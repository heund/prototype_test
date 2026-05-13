import crypto from "node:crypto";

function tokenPreview(token) {
  if (!token) return "missing";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(a || "", "utf8");
  const right = Buffer.from(b || "", "utf8");

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

export function requireBearerToken({ expectedToken, source, logEvent }) {
  if (!expectedToken || expectedToken.startsWith("replace_with_")) {
    throw new Error(`${source} token is not configured`);
  }

  return async function authMiddleware(req, res, next) {
    const header = req.get("authorization") || "";
    const [scheme, token] = header.split(" ");
    const isValid =
      scheme === "Bearer" &&
      typeof token === "string" &&
      timingSafeEqualString(token, expectedToken);

    if (!isValid) {
      await logEvent({
        source,
        nodeId: req.params.nodeId,
        event: "AUTH_FAILED",
        data: {
          path: req.originalUrl,
          token: tokenPreview(token)
        }
      });

      return res.status(401).json({ error: "Unauthorized" });
    }

    return next();
  };
}

