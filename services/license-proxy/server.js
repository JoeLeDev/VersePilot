#!/usr/bin/env node
/**
 * VersePilot License Proxy
 *
 * Garde la clé Deepgram côté serveur. Les apps clientes s'authentifient avec
 * VERSEPILOT_LICENSE_KEY (header X-VersePilot-License).
 *
 * Endpoints :
 *   GET  /health
 *   GET  /v1/license/status
 *   POST /v1/transcribe          — proxy REST Deepgram
 *   WS   /v1/stt/stream          — proxy streaming Deepgram
 */
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const PORT = Number(process.env.PORT || 4100);
const DEEPGRAM_API_KEY = (process.env.DEEPGRAM_API_KEY || "").trim();
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || "nova-3";
const DEEPGRAM_LANGUAGE = process.env.DEEPGRAM_LANGUAGE || "fr";
const DEEPGRAM_KEYWORDS_ENABLED =
  (process.env.DEEPGRAM_KEYWORDS_ENABLED || "false").toLowerCase() === "true";
const LICENSES_FILE =
  process.env.LICENSES_FILE || path.join(__dirname, "licenses.json");

const DEEPGRAM_BIBLE_KEYTERMS = [
  "Genèse", "Exode", "Jean", "Matthieu", "Romains", "Psaumes", "Actes",
  "chapitre", "verset",
];

/** @type {Map<string, { count: number, resetAt: number }>} */
const rateLimitByKey = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_PER_MIN || 120);

function checkRateLimit(licenseKey) {
  const now = Date.now();
  const entry = rateLimitByKey.get(licenseKey) || {
    count: 0,
    resetAt: now + RATE_LIMIT_WINDOW_MS,
  };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  entry.count += 1;
  rateLimitByKey.set(licenseKey, entry);
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    return {
      ok: false,
      status: 429,
      error: "Trop de requêtes — réessayez dans une minute.",
    };
  }
  return { ok: true };
}

/** @type {Map<string, { minutes: number, month: string }>} */
const usageByKey = new Map();

function loadLicenses() {
  if (!fs.existsSync(LICENSES_FILE)) {
    console.warn(`⚠ Fichier licences introuvable : ${LICENSES_FILE}`);
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(LICENSES_FILE, "utf8"));
    return Array.isArray(data?.licenses) ? data.licenses : [];
  } catch (err) {
    console.error("Erreur lecture licences :", err.message);
    return [];
  }
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function getLicenseKey(req) {
  const header = req.headers["x-versepilot-license"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return "";
}

function validateLicense(licenseKey) {
  if (!licenseKey) {
    return { ok: false, status: 401, error: "Clé de licence manquante (X-VersePilot-License)." };
  }
  const licenses = loadLicenses();
  const entry = licenses.find((l) => l.key === licenseKey);
  if (!entry) {
    return { ok: false, status: 403, error: "Licence inconnue." };
  }
  if (!entry.active) {
    return { ok: false, status: 403, error: "Licence désactivée. Contactez votre fournisseur." };
  }
  if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) {
    return { ok: false, status: 403, error: "Licence expirée. Renouvelez votre abonnement." };
  }
  const month = currentMonthKey();
  const usage = usageByKey.get(licenseKey) || { minutes: 0, month };
  if (usage.month !== month) {
    usage.minutes = 0;
    usage.month = month;
  }
  if (
    entry.maxMinutesPerMonth &&
    usage.minutes >= Number(entry.maxMinutesPerMonth)
  ) {
    return {
      ok: false,
      status: 429,
      error: "Quota mensuel de transcription atteint.",
    };
  }
  return { ok: true, entry, usage };
}

function recordUsage(licenseKey, seconds) {
  const month = currentMonthKey();
  const usage = usageByKey.get(licenseKey) || { minutes: 0, month };
  if (usage.month !== month) {
    usage.minutes = 0;
    usage.month = month;
  }
  usage.minutes += seconds / 60;
  usageByKey.set(licenseKey, usage);
}

function buildDeepgramListenParams() {
  const params = new URLSearchParams({
    model: DEEPGRAM_MODEL,
    language: DEEPGRAM_LANGUAGE,
    punctuate: "true",
    smart_format: "true",
    diarize: "false",
  });
  if (DEEPGRAM_KEYWORDS_ENABLED) {
    for (const term of DEEPGRAM_BIBLE_KEYTERMS) {
      params.append("keywords", `${term}:2`);
    }
  }
  return params;
}

function buildDeepgramStreamUrl(sampleRate) {
  const params = buildDeepgramListenParams();
  params.set("encoding", "linear16");
  params.set("sample_rate", String(sampleRate));
  params.set("channels", "1");
  params.set("interim_results", "true");
  params.set("endpointing", "300");
  params.set("vad_events", "true");
  return `wss://api.deepgram.com/v1/listen?${params}`;
}

const app = express();
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || true,
  })
);
app.use(express.raw({ type: "audio/*", limit: "25mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "versepilot-license-proxy",
    deepgramConfigured: Boolean(DEEPGRAM_API_KEY),
    licensesLoaded: loadLicenses().length,
  });
});

app.get("/v1/license/status", (req, res) => {
  const licenseKey = getLicenseKey(req);
  const rate = checkRateLimit(licenseKey || req.ip || "anon");
  if (!rate.ok) {
    return res.status(rate.status).json({ error: rate.error });
  }
  const check = validateLicense(licenseKey);
  if (!check.ok) {
    return res.status(check.status).json({ ok: false, error: check.error });
  }
  const { entry, usage } = check;
  res.json({
    ok: true,
    church: entry.church,
    plan: entry.plan || "standard",
    expiresAt: entry.expiresAt || null,
    minutesUsedThisMonth: Math.round(usage.minutes * 10) / 10,
    maxMinutesPerMonth: entry.maxMinutesPerMonth || null,
  });
});

app.post("/v1/transcribe", async (req, res) => {
  if (!DEEPGRAM_API_KEY) {
    return res.status(503).json({ error: "Deepgram non configuré sur le proxy." });
  }
  const licenseKey = getLicenseKey(req);
  const rate = checkRateLimit(licenseKey || req.ip || "anon");
  if (!rate.ok) {
    return res.status(rate.status).json({ error: rate.error });
  }
  const check = validateLicense(licenseKey);
  if (!check.ok) {
    return res.status(check.status).json({ error: check.error });
  }

  const audioBuffer = req.body;
  if (!audioBuffer?.length) {
    return res.status(400).json({ error: "Corps audio vide." });
  }

  try {
    const params = buildDeepgramListenParams();
    const r = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        "Content-Type": req.headers["content-type"] || "audio/wav",
      },
      body: audioBuffer,
      signal: AbortSignal.timeout(25000),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = data?.err_msg || data?.error || `Deepgram HTTP ${r.status}`;
      return res.status(502).json({ error: msg });
    }
    const transcript =
      data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    recordUsage(licenseKey, Math.max(3, audioBuffer.length / 32000));
    res.json({ transcript: String(transcript).trim(), engine: "deepgram" });
  } catch (err) {
    res.status(502).json({ error: err.message || "Proxy Deepgram impossible." });
  }
});

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/v1/stt/stream" });

wss.on("connection", (client, req) => {
  if (!DEEPGRAM_API_KEY) {
    client.send(JSON.stringify({ type: "error", error: "Proxy Deepgram non configuré." }));
    client.close();
    return;
  }

  const licenseKey = getLicenseKey(req);
  const rate = checkRateLimit(licenseKey || req.ip || "anon");
  if (!rate.ok) {
    return res.status(rate.status).json({ error: rate.error });
  }
  const check = validateLicense(licenseKey);
  if (!check.ok) {
    client.send(JSON.stringify({ type: "error", error: check.error }));
    client.close();
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const sampleRate = Number(url.searchParams.get("sampleRate")) || 16000;

  const dg = new WebSocket(buildDeepgramStreamUrl(sampleRate), {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  let dgOpen = false;
  const audioBacklog = [];
  let keepAlive = null;
  let streamStartedAt = Date.now();

  dg.on("open", () => {
    dgOpen = true;
    for (const buf of audioBacklog) dg.send(buf);
    audioBacklog.length = 0;
    keepAlive = setInterval(() => {
      if (dg.readyState === WebSocket.OPEN) {
        dg.send(JSON.stringify({ type: "KeepAlive" }));
      }
    }, 8000);
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "ready" }));
    }
  });

  dg.on("message", (raw) => {
    let data = null;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (data.type === "Results") {
      const alt = data.channel?.alternatives?.[0];
      const text = (alt?.transcript || "").trim();
      if (!text) return;
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            type: "transcript",
            text,
            isFinal: Boolean(data.is_final),
            speechFinal: Boolean(data.speech_final),
            confidence: alt?.confidence ?? null,
          })
        );
      }
    }
  });

  dg.on("error", (err) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "error", error: `Deepgram: ${err.message}` }));
    }
  });

  dg.on("close", () => {
    if (keepAlive) clearInterval(keepAlive);
    const seconds = (Date.now() - streamStartedAt) / 1000;
    recordUsage(licenseKey, seconds);
    if (client.readyState === WebSocket.OPEN) client.close();
  });

  client.on("message", (data, isBinary) => {
    if (isBinary) {
      if (dgOpen && dg.readyState === WebSocket.OPEN) dg.send(data);
      else audioBacklog.push(data);
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "CloseStream" && dg.readyState === WebSocket.OPEN) {
        dg.send(JSON.stringify({ type: "CloseStream" }));
      }
    } catch {
      /* ignore */
    }
  });

  client.on("close", () => {
    if (keepAlive) clearInterval(keepAlive);
    const seconds = (Date.now() - streamStartedAt) / 1000;
    recordUsage(licenseKey, seconds);
    if (dg.readyState === WebSocket.OPEN) {
      try {
        dg.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        /* ignore */
      }
    }
    dg.close();
  });

  client.on("error", () => {
    if (keepAlive) clearInterval(keepAlive);
    dg.close();
  });
});

httpServer.listen(PORT, () => {
  console.log(`✅ VersePilot License Proxy on http://0.0.0.0:${PORT}`);
  if (!DEEPGRAM_API_KEY) {
    console.warn("⚠ DEEPGRAM_API_KEY manquante — configure services/license-proxy/.env");
  }
  console.log(`📋 Licences : ${LICENSES_FILE} (${loadLicenses().length} entrée(s))`);
});
