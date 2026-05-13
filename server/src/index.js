import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createRoutes } from "./routes.js";
import { createStore } from "./store.js";

const app = express();
const port = Number(process.env.PORT || 3000);
const adminOrigin = process.env.ADMIN_ORIGIN || "http://localhost:3000";
const nodeId = process.env.NODE_ID || "fan-node-01";

const store = createStore({ nodeId });
await store.ensureDataFiles();

function requestOrigin(req) {
  const protocol = req.get("x-forwarded-proto") || req.protocol;
  return `${protocol}://${req.get("host")}`;
}

app.set("trust proxy", 1);
app.use(helmet());
app.use(
  cors((req, callback) => {
    callback(null, {
      origin(origin, originCallback) {
        const allowedOrigins = new Set([adminOrigin, requestOrigin(req)]);

        if (!origin || allowedOrigins.has(origin)) {
          originCallback(null, true);
          return;
        }

        originCallback(new Error("CORS origin denied"));
      }
    });
  })
);
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false
  })
);
app.use(express.json({ limit: "10kb" }));

app.use(
  createRoutes({
    store,
    nodeId,
    adminToken: process.env.ADMIN_TOKEN,
    deviceToken: process.env.DEVICE_TOKEN
  })
);

app.use(async (err, req, res, _next) => {
  await store.appendLog({
    source: "server",
    nodeId,
    event: "ERROR",
    data: {
      path: req.originalUrl,
      message: err.message
    }
  });

  res.status(err.status || 500).json({ error: "Server error" });
});

app.listen(port, () => {
  console.log(`fan-control-test listening on port ${port}`);
});
