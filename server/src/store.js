import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "../data");
const statePath = path.join(dataDir, "state.json");
const logsPath = path.join(dataDir, "logs.jsonl");
const heartbeatPath = path.join(dataDir, "heartbeat.json");

function defaultState(nodeId) {
  return {
    nodeId,
    mode: "manual",
    fans: {
      fan1: 0
    },
    updatedAt: new Date().toISOString(),
    updatedBy: "system"
  };
}

async function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

export function createStore({ nodeId }) {
  return {
    async ensureDataFiles() {
      await fs.mkdir(dataDir, { recursive: true });

      try {
        await fs.access(statePath);
      } catch {
        await writeJsonAtomic(statePath, defaultState(nodeId));
      }

      try {
        await fs.access(logsPath);
      } catch {
        await fs.writeFile(logsPath, "", "utf8");
      }
    },

    async readState() {
      const content = await fs.readFile(statePath, "utf8");
      return JSON.parse(content);
    },

    async writeState(state) {
      await writeJsonAtomic(statePath, state);
    },

    async appendLog({ source, nodeId: entryNodeId, event, data = {} }) {
      const entry = {
        time: new Date().toISOString(),
        source,
        nodeId: entryNodeId || nodeId,
        event,
        data
      };
      await fs.appendFile(logsPath, `${JSON.stringify(entry)}\n`, "utf8");
    },

    async readRecentLogs(limit) {
      const content = await fs.readFile(logsPath, "utf8");
      return content
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-limit)
        .map((line) => JSON.parse(line));
    },

    async writeLastHeartbeat(heartbeat) {
      await writeJsonAtomic(heartbeatPath, heartbeat);
    },

    async readLastHeartbeat() {
      try {
        const content = await fs.readFile(heartbeatPath, "utf8");
        return JSON.parse(content);
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
    }
  };
}
