import "dotenv/config";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createKnowledgeSession, runKnowledgeSession, sessions } from "./src/orchestrator.js";
import { resolveModel } from "./src/model-resolver.js";
import { getLatestKnowledge, getKnowledgeById, listKnowledge } from "./src/knowledge-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4174;
const API_KEY = process.env.API_KEY || "";

let CONFIG = null;
async function loadConfig() {
  const raw = await readFile(path.join(__dirname, "config.json"), "utf8");
  CONFIG = JSON.parse(raw);
}
await loadConfig();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.join(__dirname, "public", rel);
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

function pickModel(id) {
  const entry = CONFIG.models.find((m) => m.id === id);
  return entry ? resolveModel(entry, CONFIG.engines) : null;
}

// Optional, lightweight auth for the endpoints an external system (Qwen) would
// call - only enforced if API_KEY is set in .env. Local testing without an
// API_KEY set stays wide open, per the PRD's "don't over-engineer v1" note.
function requireApiKey(req, res) {
  if (!API_KEY) return true;
  const provided = req.headers["x-api-key"];
  if (provided === API_KEY) return true;
  json(res, 401, { error: "Unauthorized: header X-API-Key tidak valid/kosong." });
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === "/api/generate" && req.method === "POST") {
      if (!requireApiKey(req, res)) return;
      const body = await readBody(req);
      const referenceDate = String(body.referenceDate || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate)) {
        return json(res, 400, { error: "referenceDate wajib diisi, format YYYY-MM-DD." });
      }

      const participantIds = Array.isArray(body.participantIds) && body.participantIds.length
        ? body.participantIds
        : CONFIG.defaultParticipantIds;
      const judgeId = body.judgeId || CONFIG.defaultJudgeId;

      const participants = participantIds.map(pickModel).filter(Boolean);
      const judge = pickModel(judgeId);

      if (participants.length < 2) return json(res, 400, { error: "Minimal 2 peserta diskusi." });
      if (!judge) return json(res, 400, { error: "Juri tidak valid." });
      if (participants.some((p) => p.id === judge.id)) {
        return json(res, 400, { error: "Juri tidak boleh sama dengan salah satu peserta (supaya anonimisasi tetap netral)." });
      }

      const rounds = Math.min(
        Math.max(parseInt(body.rounds, 10) || CONFIG.settings.defaultRounds, CONFIG.settings.minRounds),
        CONFIG.settings.maxRounds
      );

      const session = createKnowledgeSession({ referenceDate, rounds, participants, judge, settings: CONFIG.settings });
      runKnowledgeSession(session).catch((err) => {
        session.status = "error";
        session.bus.emit("event", { type: "session-error", data: { message: err.message }, ts: Date.now() });
      });

      return json(res, 200, { sessionId: session.id });
    }

    const streamMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
    if (streamMatch && req.method === "GET") {
      const session = sessions.get(streamMatch[1]);
      if (!session) {
        res.writeHead(404);
        return res.end("Session not found");
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(":ok\n\n");

      for (const event of session.log) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      }
      if (session.status === "done" || session.status === "error") {
        res.write(`event: stream-end\ndata: {}\n\n`);
        return res.end();
      }

      const onEvent = (event) => {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
        if (event.type === "session-done" || event.type === "session-error") {
          res.write(`event: stream-end\ndata: {}\n\n`);
          cleanup();
          res.end();
        }
      };
      const heartbeat = setInterval(() => res.write(":hb\n\n"), 15000);
      const cleanup = () => {
        clearInterval(heartbeat);
        session.bus.off("event", onEvent);
      };
      session.bus.on("event", onEvent);
      req.on("close", cleanup);
      return;
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch && req.method === "GET") {
      const session = sessions.get(sessionMatch[1]);
      if (!session) return json(res, 404, { error: "Not found" });
      return json(res, 200, {
        id: session.id,
        status: session.status,
        topic: session.topic,
        targetPeriod: session.targetPeriod,
        rounds: session.rounds,
        bundle: session.bundle,
        stoppedEarly: session.stoppedEarly,
      });
    }

    if (url.pathname === "/api/knowledge/latest" && req.method === "GET") {
      if (!requireApiKey(req, res)) return;
      const bundle = await getLatestKnowledge(CONFIG.settings.knowledgeDir);
      if (!bundle) return json(res, 404, { error: "Belum ada knowledge bundle yang digenerate." });
      return json(res, 200, bundle);
    }

    if (url.pathname === "/api/knowledge" && req.method === "GET") {
      if (!requireApiKey(req, res)) return;
      const bundles = await listKnowledge(
        { from: url.searchParams.get("from"), to: url.searchParams.get("to") },
        CONFIG.settings.knowledgeDir
      );
      return json(res, 200, { bundles });
    }

    const knowledgeIdMatch = url.pathname.match(/^\/api\/knowledge\/([^/]+)$/);
    if (knowledgeIdMatch && req.method === "GET") {
      if (!requireApiKey(req, res)) return;
      const bundle = await getKnowledgeById(knowledgeIdMatch[1], CONFIG.settings.knowledgeDir);
      if (!bundle) return json(res, 404, { error: "Knowledge bundle tidak ditemukan." });
      return json(res, 200, bundle);
    }

    if (url.pathname.startsWith("/api/")) {
      return json(res, 404, { error: "Unknown endpoint" });
    }

    return serveStatic(req, res, url.pathname);
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Wrapstation Knowledge Orchestrator jalan di http://localhost:${PORT}\n`);
});
