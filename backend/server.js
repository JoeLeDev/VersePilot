// VersePilot Live — Backend
// Express server: fuzzy Bible verse search via OpenAI + ProPresenter dispatch.

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { execFile, spawn } from "child_process";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import OpenAI from "openai";
import {
  verseKey,
  cosineSimilarity,
  similarityToScore,
  loadEmbeddingIndex,
  getEmbeddingForIndex,
} from "./lib/verse-embeddings.js";
import { detectDirectReferences } from "./lib/direct-reference.js";
import {
  applyBiblicalLexicon,
  getLexiconStats,
} from "./lib/biblical-lexicon.js";
import {
  getLicenseConfig,
  isDeepgramAvailable,
  proxyWsUrl,
} from "./lib/versepilot-license.js";
import { runBibleImport } from "./scripts/import-bibles.mjs";
import { runBuildEmbeddings } from "./scripts/build-embeddings.mjs";
import {
  embedQueriesLocal,
  isNodeEmbedAvailable,
} from "./lib/local-query-embed.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envFile =
  process.env.VERSEPILOT_ENV_FILE || path.join(__dirname, ".env");
dotenv.config({ path: envFile });

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 4000;
const SEARCH_MODE = (process.env.SEARCH_MODE || "offline").toLowerCase();
const SEMANTIC_SEARCH = (process.env.SEMANTIC_SEARCH || "openai").toLowerCase();
const OPENAI_EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
// Fournisseur d'embeddings utilisé pour la recherche sémantique : "openai" ou "local".
const EMBEDDING_PROVIDER = SEMANTIC_SEARCH === "local" ? "local" : "openai";
const LOCAL_EMBED_URL = (
  process.env.LOCAL_EMBED_URL || "http://127.0.0.1:8003"
).replace(/\/$/, "");
const LOCAL_EMBED_MODEL =
  process.env.LOCAL_EMBED_MODEL || "intfloat/multilingual-e5-small";
// Seuil cosinus minimal pour les matchs sémantiques (manuel vs live).
const SEMANTIC_MIN_SIM = Number(process.env.SEMANTIC_MIN_SIM) || 0.32;
const SEMANTIC_LIVE_MIN_SIM = Number(process.env.SEMANTIC_LIVE_MIN_SIM) || 0.38;
const STT_MODE = (process.env.STT_MODE || "local").toLowerCase();
const MLX_STT_URL = (process.env.MLX_STT_URL || "http://127.0.0.1:8002").replace(
  /\/$/,
  ""
);
const MLX_STT_LANG = process.env.MLX_STT_LANG || "fr";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const LICENSE_CONFIG = getLicenseConfig();
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || "nova-3";
const DEEPGRAM_LANGUAGE = process.env.DEEPGRAM_LANGUAGE || "fr";
// ATTENTION : nova-3 n'accepte PAS `keywords` (supprimé) et `keyterm` est
// réservé à l'anglais → activer ce boost en fr/nova-3 fait échouer Deepgram (400).
// Désactivé par défaut ; à n'activer que sur nova-2 ou un modèle anglais.
const DEEPGRAM_KEYWORDS_ENABLED =
  (process.env.DEEPGRAM_KEYWORDS_ENABLED || "false").toLowerCase() === "true";
// Termes prioritaires pour booster la reconnaissance des références bibliques.
const DEEPGRAM_BIBLE_KEYTERMS = [
  "Genèse", "Exode", "Lévitique", "Nombres", "Deutéronome", "Josué", "Juges",
  "Ruth", "Samuel", "Rois", "Chroniques", "Esdras", "Néhémie", "Esther",
  "Job", "Psaumes", "Proverbes", "Ecclésiaste", "Cantique", "Ésaïe",
  "Jérémie", "Lamentations", "Ézéchiel", "Daniel", "Osée", "Joël", "Amos",
  "Abdias", "Jonas", "Michée", "Nahum", "Habacuc", "Sophonie", "Aggée",
  "Zacharie", "Malachie", "Matthieu", "Marc", "Luc", "Jean", "Actes",
  "Romains", "Corinthiens", "Galates", "Éphésiens", "Philippiens",
  "Colossiens", "Thessaloniciens", "Timothée", "Tite", "Philémon", "Hébreux",
  "Jacques", "Pierre", "Jude", "Apocalypse", "chapitre", "verset",
];
const STREAMING_AVAILABLE =
  isDeepgramAvailable(DEEPGRAM_API_KEY, LICENSE_CONFIG) &&
  (STT_MODE === "deepgram" || STT_MODE === "hybrid");
const OPENAI_TRANSCRIBE_MODEL =
  process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const WHISPER_MODE = (process.env.WHISPER_MODE || "local").toLowerCase();
const WHISPER_BIN = process.env.WHISPER_BIN || "whisper-cli";
const WHISPER_MODEL_PATH =
  process.env.WHISPER_MODEL_PATH ||
  path.join(__dirname, "models", "ggml-base.bin");
const WHISPER_LANG = process.env.WHISPER_LANG || "fr";
const WHISPER_BEAM_SIZE = Number(process.env.WHISPER_BEAM_SIZE || 5);
const WHISPER_THREADS = Number(process.env.WHISPER_THREADS || 6);
const WHISPER_SUPPRESS_NST =
  (process.env.WHISPER_SUPPRESS_NST || "true").toLowerCase() !== "false";
const WHISPER_CARRY_PROMPT =
  (process.env.WHISPER_CARRY_PROMPT || "true").toLowerCase() !== "false";
const WHISPER_NO_GPU =
  process.env.WHISPER_NO_GPU !== undefined
    ? process.env.WHISPER_NO_GPU.toLowerCase() !== "false"
    : process.platform === "darwin";
// --vad de whisper-cli plante souvent sur macOS (meme avec -ng).
const WHISPER_USE_VAD =
  process.env.WHISPER_USE_VAD !== undefined
    ? process.env.WHISPER_USE_VAD.toLowerCase() === "true"
    : false;
const WHISPER_PROMPT_MAX_CHARS = Number(process.env.WHISPER_PROMPT_MAX_CHARS || 600);
const execFileAsync = promisify(execFile);

// --- Load verse database (un fichier JSON par version) ---
const BIBLES_DIR = path.join(__dirname, "data", "bibles");
const SAMPLE_VERSES_PATH = path.join(__dirname, "data", "verses.json");
const DEFAULT_BIBLE_SLUG = process.env.BIBLE_VERSION || "louis-segond";

let activeBibleSlug = DEFAULT_BIBLE_SLUG;
let BIBLE_META = { slug: "sample", code: "LSG", name: "Échantillon local" };
let VERSES = [];
let BIBLE_BOOKS = [];
const versesByBookNorm = new Map();
const verseIndexByKey = new Map();
let embeddingIndex = null;

/** Index par slug pour lecture multi-versions sans recharger la bible active. */
const bibleIndexCache = new Map();

/** @type {{ running: boolean, progress: object | null, error: string | null, result: object | null }} */
let bibleImportState = {
  running: false,
  progress: null,
  error: null,
  result: null,
};

/** @type {{ running: boolean, progress: object | null, error: string | null, result: object | null }} */
let embeddingBuildState = {
  running: false,
  progress: null,
  error: null,
  result: null,
};

let localEmbedServerProcess = null;

function countInstalledBibles() {
  return listAvailableBibles().filter(
    (v) => v.available !== false && (v.verseCount || 0) > 0
  ).length;
}

function needsEmbeddingIndex(slug = activeBibleSlug) {
  if (SEMANTIC_SEARCH === "off") return false;
  if (EMBEDDING_PROVIDER === "openai" && !process.env.OPENAI_API_KEY) return false;
  return !loadEmbeddingIndex(BIBLES_DIR, slug, EMBEDDING_PROVIDER);
}

async function probeLocalEmbedServer() {
  try {
    const r = await fetch(`${LOCAL_EMBED_URL}/health`, {
      signal: AbortSignal.timeout(2500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureLocalEmbedServer(maxWaitMs = 90000) {
  if (await probeLocalEmbedServer()) return true;

  if (!localEmbedServerProcess) {
    const scriptPath = path.join(__dirname, "scripts", "embeddings", "local_embed_server.py");
    if (!fs.existsSync(scriptPath)) {
      throw new Error("Serveur d'embeddings local introuvable dans l'installation.");
    }
    localEmbedServerProcess = spawn("python3", [scriptPath], {
      cwd: __dirname,
      env: { ...process.env },
      stdio: "ignore",
      detached: false,
    });
    localEmbedServerProcess.on("exit", () => {
      localEmbedServerProcess = null;
    });
  }

  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await probeLocalEmbedServer()) return true;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  throw new Error(
    "Le serveur d'embeddings local n'a pas démarré à temps. Vérifiez que Python 3 est installé."
  );
}

function reloadEmbeddingIndex(slug = activeBibleSlug) {
  embeddingIndex = null;
  if (SEMANTIC_SEARCH === "off") return false;
  if (EMBEDDING_PROVIDER === "openai" && !process.env.OPENAI_API_KEY) return false;
  try {
    embeddingIndex = loadEmbeddingIndex(BIBLES_DIR, slug, EMBEDDING_PROVIDER);
    if (embeddingIndex) {
      console.log(
        `🔍 Index sémantique rechargé [${EMBEDDING_PROVIDER}]: ${embeddingIndex.count} versets`
      );
    }
    return Boolean(embeddingIndex);
  } catch (err) {
    console.warn("Rechargement index sémantique:", err.message);
    return false;
  }
}

function listBibleFiles() {
  if (!fs.existsSync(BIBLES_DIR)) return [];
  return fs
    .readdirSync(BIBLES_DIR)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => f.replace(/\.json$/, ""));
}

function listAvailableBibles() {
  const indexPath = path.join(BIBLES_DIR, "index.json");
  if (fs.existsSync(indexPath)) {
    try {
      const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      if (index.versions?.length) return index.versions;
    } catch {
      /* ignore */
    }
  }
  return listBibleFiles().map((slug) => {
    try {
      const payload = JSON.parse(
        fs.readFileSync(path.join(BIBLES_DIR, `${slug}.json`), "utf-8")
      );
      const meta = payload.meta || {};
      return {
        slug,
        code: meta.code || slug.toUpperCase(),
        name: meta.name || slug,
        file: `${slug}.json`,
        verseCount: meta.verseCount || payload.verses?.length || 0,
        available: meta.available !== false && (payload.verses?.length || 0) > 0,
        unavailableReason: meta.unavailableReason,
      };
    } catch {
      return {
        slug,
        code: slug.toUpperCase(),
        name: slug,
        file: `${slug}.json`,
        available: false,
      };
    }
  });
}

function rebuildSearchIndex() {
  versesByBookNorm.clear();
  verseIndexByKey.clear();
  VERSES.forEach((v, i) => {
    verseIndexByKey.set(verseKey(v), i);
    const key = normalize(v.book || "");
    if (!versesByBookNorm.has(key)) versesByBookNorm.set(key, []);
    versesByBookNorm.get(key).push(v);
  });
  BIBLE_BOOKS = [...new Set(VERSES.map((v) => v.book).filter(Boolean))].sort();
}

/** Désactivé par défaut : Whisper/OpenAI répètent le prompt sur silence ou courts extraits. */
const OPENAI_TRANSCRIBE_USE_PROMPT =
  (process.env.OPENAI_TRANSCRIBE_USE_PROMPT || "false").toLowerCase() === "true";
const OPENAI_TRANSCRIBE_PROMPT = OPENAI_TRANSCRIBE_USE_PROMPT
  ? (
      process.env.OPENAI_TRANSCRIBE_PROMPT ||
      "Prédication en français. Lecture biblique Louis Segond."
    ).slice(0, 224)
  : "";

const STT_PROMPT_ECHO_PHRASES = [
  "Prédication en français. Lecture biblique Louis Segond.",
  "Prédication en français. Lecture biblique Louis Segond",
  "Bible française Louis Segond, versets bibliques, référence livre chapitre verset.",
  "Bible française, versets bibliques en français.",
  "Lecture biblique Louis Segond.",
  "Prédication en français.",
];

/** Hallucinations Whisper/MLX sur silence (pas de vraie parole). */
const STT_HALLUCINATION_PHRASES = [
  "Sous-titrage Société Radio-Canada",
  "Sous-titrage ST' 501",
  "Sous-titrage ST'501",
  "Merci d'avoir regardé",
  "Merci de regarder",
  "Thank you for watching",
  "Thanks for watching",
  "Subtitles by the Amara.org community",
  "Subtitles by Amara.org",
  "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
];

function isSttKnownHallucination(text) {
  const n = normalize(text);
  if (!n) return false;
  for (const phrase of STT_HALLUCINATION_PHRASES) {
    const p = normalize(phrase);
    if (!p) continue;
    if (n === p || n.includes(p)) return true;
  }
  if (/sous\s*titrage/.test(n) && /radio\s*canada/.test(n)) return true;
  if (/sous\s*titrage/.test(n) && n.length < 80) return true;
  if (/merci\s+d\s*avoir\s+regard/.test(n)) return true;
  if (/thank\s*you\s+for\s+watching/.test(n)) return true;
  if (/subtitle/.test(n) && n.length < 120) return true;
  return false;
}

function buildWhisperCppPrompt() {
  if (process.env.WHISPER_PROMPT) {
    return process.env.WHISPER_PROMPT.slice(0, WHISPER_PROMPT_MAX_CHARS);
  }
  const booksHint = BIBLE_BOOKS.filter(
    (b) => !/\b(chronicles|corinthians|kings|peter|samuel|thessalonians|timothy|john)\b/i.test(b)
  ).slice(0, 24);
  return [
    "Bible française, versets bibliques en français.",
    ...booksHint,
    "Seigneur, Jésus, Christ, Dieu, Esprit, prière, grâce, foi, lumière, amour.",
  ]
    .join(" ")
    .slice(0, WHISPER_PROMPT_MAX_CHARS);
}

let WHISPER_CPP_PROMPT = "";

function loadBible(slug = DEFAULT_BIBLE_SLUG) {
  const filePath = path.join(BIBLES_DIR, `${slug}.json`);
  if (fs.existsSync(filePath)) {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    VERSES = payload.verses || payload;
    BIBLE_META = payload.meta || { slug, code: slug, name: slug };
    if (BIBLE_META.available === false || VERSES.length === 0) {
      throw new Error(
        BIBLE_META.unavailableReason ||
          `La version « ${slug} » n'est pas encore importée (versets vides).`
      );
    }
    activeBibleSlug = slug;
    rebuildSearchIndex();
    WHISPER_CPP_PROMPT = buildWhisperCppPrompt();
    embeddingIndex = null;
    const semanticReady =
      SEMANTIC_SEARCH !== "off" &&
      (EMBEDDING_PROVIDER === "local" || Boolean(process.env.OPENAI_API_KEY));
    if (semanticReady) {
      try {
        embeddingIndex = loadEmbeddingIndex(BIBLES_DIR, slug, EMBEDDING_PROVIDER);
        if (embeddingIndex) {
          console.log(
            `🔍 Index sémantique [${EMBEDDING_PROVIDER}]: ${embeddingIndex.count} versets (${embeddingIndex.model})`
          );
        } else {
          const cmd =
            EMBEDDING_PROVIDER === "local"
              ? "npm run build-embeddings:local"
              : "npm run build-embeddings";
          console.warn(
            `⚠️  Pas d'index sémantique [${EMBEDDING_PROVIDER}] pour ${slug}. Lance: ${cmd}`
          );
        }
      } catch (err) {
        console.warn("Index sémantique:", err.message);
      }
    }
    console.log(
      `📖 Bible chargée: ${BIBLE_META.name} (${VERSES.length} versets) ← ${filePath}`
    );
    return true;
  }

  if (fs.existsSync(SAMPLE_VERSES_PATH)) {
    VERSES = JSON.parse(fs.readFileSync(SAMPLE_VERSES_PATH, "utf-8"));
    BIBLE_META = {
      slug: "sample",
      code: "LSG",
      name: "Échantillon (verses.json) — lance npm run import-bibles",
    };
    activeBibleSlug = "sample";
    rebuildSearchIndex();
    WHISPER_CPP_PROMPT = buildWhisperCppPrompt();
    console.warn(
      `⚠️  ${slug}.json introuvable. Fallback verset sample (${VERSES.length}). Exécute: npm run import-bibles`
    );
    return false;
  }

  throw new Error("Aucune bible disponible. Lance npm run import-bibles dans backend/");
}

loadBible(DEFAULT_BIBLE_SLUG);

if (WHISPER_NO_GPU) {
  console.log("🎙️ Whisper: mode CPU (GPU Metal desactive, plus stable sur macOS).");
}
console.log(
  `🎙️ STT mode: ${STT_MODE} (deepgram: ${DEEPGRAM_MODEL}/${DEEPGRAM_LANGUAGE}, mlx: ${MLX_STT_URL})`
);
if (STT_MODE === "mlx" || STT_MODE === "hybrid") {
  probeMlxStt().then((p) => {
    if (!p.ok) {
      console.warn(
        `⚠️ Serveur MLX STT non joignable (${MLX_STT_URL}). Lance: npm run mlx-stt --prefix backend`
      );
    } else if (!p.modelLoaded) {
      console.warn(
        "⚠️ MLX STT actif mais modele pas encore charge — premier /transcribe ou GET /warmup."
      );
    }
  });
}

const BOOK_ALIASES = [
  [/\bjan\b/gi, "Jean"],
  [/\bjohan\b/gi, "Jean"],
  [/\bjohn\b/gi, "Jean"],
  [/\bmatieu\b/gi, "Matthieu"],
  [/\bmatheu\b/gi, "Matthieu"],
  [/\bpsaume\b/gi, "Psaumes"],
  [/\bsaume\b/gi, "Psaumes"],
  [/\bpsalm\b/gi, "Psaumes"],
  [/\bproverbe\b/gi, "Proverbes"],
  [/\bromain\b/gi, "Romains"],
  [/\bcore?inthiens?\b/gi, "Corinthiens"],
  [/\bgalatien\b/gi, "Galates"],
  [/\bephesiens?\b/gi, "Éphésiens"],
  [/\bthessaloniciens?\b/gi, "Thessaloniciens"],
  [/\bhebreux?\b/gi, "Hébreux"],
  [/\bapocalipse\b/gi, "Apocalypse"],
  [/\bgenese\b/gi, "Genèse"],
  [/\bdeuteronom?e\b/gi, "Deutéronome"],
  [/\bjeremie\b/gi, "Jérémie"],
  [/\besai?e\b/gi, "Ésaïe"],
  [/\bphilippiens?\b/gi, "Philippiens"],
  [/\bcolossiens?\b/gi, "Colossiens"],
];

// --- OpenAI client ---
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
    })
  : null;

// --- Helpers ---
const DEFAULT_PP_PORT = 50001;

/**
 * Normalize a string: lowercase, strip accents and punctuation.
 */
function normalize(str) {
  if (str == null) return "";
  const s = typeof str === "string" ? str : String(str);
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pre-filter candidate verses by simple text matching to narrow the prompt.
 * Returns top N candidates, falling back to a broader sample if nothing matches.
 */
function getCandidatePool(query) {
  const q = normalize(query);
  if (!q) return VERSES.slice(0, 200);

  const refMatch = q.match(/([1-3]?\s?[a-z]+)\s+(\d+)(?:\s*[:.]\s*(\d+))?/);
  if (refMatch) {
    const refBook = normalize(refMatch[1]);
    const refChapter = parseInt(refMatch[2], 10);
    const pool = [];
    for (const [bookNorm, verses] of versesByBookNorm.entries()) {
      if (bookNorm.includes(refBook) || refBook.includes(bookNorm)) {
        for (const v of verses) {
          if (!refChapter || v.chapter === refChapter) pool.push(v);
        }
      }
    }
    if (pool.length) return pool;
  }

  const tokens = q.split(" ").filter((t) => t.length >= 3);
  if (!tokens.length) return VERSES.slice(0, 200);

  const pool = [];
  for (const v of VERSES) {
    const haystack = normalize(`${v.book} ${v.chapter}:${v.verse} ${v.text}`);
    if (tokens.some((tok) => haystack.includes(tok))) pool.push(v);
    if (pool.length >= 800) break;
  }
  return pool.length ? pool : VERSES.slice(0, 200);
}

function prefilterCandidates(query, max = 25) {
  const q = normalize(query);
  if (!q) return VERSES.slice(0, max);

  const tokens = q.split(" ").filter((t) => t.length >= 3);
  const refMatch = q.match(/([1-3]?\s?[a-z]+)\s+(\d+)(?:\s*[:.]\s*(\d+))?/);
  const pool = getCandidatePool(query);

  const scored = pool.map((v) => {
    const haystack = normalize(`${v.book} ${v.chapter}:${v.verse} ${v.text}`);
    let score = 0;

    if (refMatch) {
      const refBook = normalize(refMatch[1]);
      const refChapter = parseInt(refMatch[2], 10);
      const refVerse = refMatch[3] ? parseInt(refMatch[3], 10) : null;

      if (normalize(v.book).includes(refBook) || refBook.includes(normalize(v.book))) {
        score += 50;
        if (v.chapter === refChapter) score += 30;
        if (refVerse && v.verse === refVerse) score += 50;
      }
    }

    for (const tok of tokens) {
      if (haystack.includes(tok)) score += 2;
    }

    return { v, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter((s) => s.score > 0).slice(0, max).map((s) => s.v);
  return top.length >= 3 ? top : pool.slice(0, max);
}

function tokenize(str) {
  return normalize(str)
    .split(" ")
    .filter((t) => t.length >= 2);
}

function buildReference(v) {
  return `${v.book} ${v.chapter}:${v.verse}`;
}

function verseCoords(v) {
  return { book: v.book, chapter: v.chapter, verse: v.verse };
}

function suggestionFromVerse(v, extra = {}) {
  return {
    reference: buildReference(v),
    version: v.version,
    text: v.text,
    ...verseCoords(v),
    ...extra,
  };
}

function getBibleIndexForSlug(slug) {
  if (bibleIndexCache.has(slug)) return bibleIndexCache.get(slug);
  const filePath = path.join(BIBLES_DIR, `${slug}.json`);
  if (!fs.existsSync(filePath)) return null;
  const payload = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const verses = payload.verses || [];
  if (!verses.length) return null;
  const byKey = new Map();
  const chapterVerses = new Map();
  for (const v of verses) {
    byKey.set(verseKey(v), v);
    const ck = `${normalize(v.book)}|${v.chapter}`;
    if (!chapterVerses.has(ck)) chapterVerses.set(ck, []);
    chapterVerses.get(ck).push(v);
  }
  for (const list of chapterVerses.values()) {
    list.sort((a, b) => a.verse - b.verse);
  }
  const index = {
    meta: payload.meta || { slug, name: slug },
    verses,
    byKey,
    chapterVerses,
  };
  bibleIndexCache.set(slug, index);
  return index;
}

function findChapterVersesInIndex(index, book, chapter) {
  const bookNorm = normalize(book);
  for (const [key, list] of index.chapterVerses.entries()) {
    const sep = key.lastIndexOf("|");
    const bk = key.slice(0, sep);
    const ch = Number(key.slice(sep + 1));
    if (ch !== chapter) continue;
    if (bk === bookNorm || bk.includes(bookNorm) || bookNorm.includes(bk)) {
      return list;
    }
  }
  return [];
}

function lookupVerseInSlug(slug, book, chapter, verse) {
  const index = getBibleIndexForSlug(slug);
  if (!index) return null;
  const direct = index.byKey.get(verseKey({ book, chapter, verse }));
  if (direct) return direct;
  const chapterList = findChapterVersesInIndex(index, book, chapter);
  return chapterList.find((v) => v.verse === verse) || null;
}

function getBibleContext(slug, book, chapter, centerVerse, radius = 3) {
  const index = getBibleIndexForSlug(slug);
  if (!index) return null;
  const chapterList = findChapterVersesInIndex(index, book, chapter);
  if (!chapterList.length) return null;
  const centerIdx = chapterList.findIndex((v) => v.verse === centerVerse);
  if (centerIdx < 0) return null;
  const start = Math.max(0, centerIdx - radius);
  const end = Math.min(chapterList.length - 1, centerIdx + radius);
  const center = chapterList[centerIdx];
  return {
    book: center.book,
    chapter,
    centerVerse,
    radius,
    version: slug,
    versionName: index.meta.name || slug,
    verses: chapterList.slice(start, end + 1).map((v) => ({
      ...verseCoords(v),
      reference: buildReference(v),
      text: v.text,
      isCenter: v.verse === centerVerse,
    })),
  };
}

function parseReferenceString(ref) {
  const m = String(ref || "")
    .trim()
    .match(/^(.+?)\s+(\d+)\s*:\s*(\d+)\s*$/);
  if (!m) return null;
  return {
    book: m[1].trim(),
    chapter: parseInt(m[2], 10),
    verse: parseInt(m[3], 10),
  };
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textHasWholeToken(textNorm, tok) {
  if (!tok || tok.length < 3) return false;
  return new RegExp(`\\b${escapeRegex(tok)}\\b`, "i").test(textNorm);
}

function booksMatch(qBook, bookNorm) {
  if (!qBook || !bookNorm) return false;
  return bookNorm.includes(qBook) || qBook.includes(bookNorm);
}

function applyChapterBonuses(query, ranked) {
  if (!ranked.length) return ranked;

  const q = normalize(query);
  const refMatch = q.match(/([1-3]?\s?[a-z]+)\s+(\d+)(?:\s*[:.]\s*(\d+))?/);
  let bookHint = null;
  let chapterHint = null;

  if (refMatch) {
    bookHint = normalize(refMatch[1]);
    chapterHint = parseInt(refMatch[2], 10);
  } else {
    const top = ranked[0];
    if ((top.tokenHits || 0) >= 3) {
      bookHint = normalize(top.book || "");
      chapterHint = top.chapter;
    }
  }

  if (!bookHint || !chapterHint) return ranked;

  const boosted = ranked.map((row) => {
    const bNorm = normalize(row.book || "");
    if (!booksMatch(bookHint, bNorm) || row.chapter !== chapterHint) {
      return row;
    }
    const reason = row.reason?.includes("chapitre")
      ? row.reason
      : `${row.reason} · même chapitre`;
    return {
      ...row,
      score: row.score + 28,
      reason,
    };
  });

  return boosted.sort(
    (a, b) => b.tokenHits - a.tokenHits || b.score - a.score
  );
}

function scoreVerseLocal(query, verse) {
  const q = normalize(query);
  const ref = buildReference(verse);
  const refNorm = normalize(ref);
  const textNorm = normalize(verse.text || "");
  const bookNorm = normalize(verse.book || "");

  let score = 0;
  const reasons = [];

  // Reference-friendly match: "jean 3:16", "1 cor 13", etc.
  const refMatch = q.match(/([1-3]?\s?[a-z]+)\s+(\d+)(?:\s*[:.]\s*(\d+))?/);
  if (refMatch) {
    const qBook = normalize(refMatch[1]);
    const qChapter = parseInt(refMatch[2], 10);
    const qVerse = refMatch[3] ? parseInt(refMatch[3], 10) : null;

    if (bookNorm.includes(qBook) || qBook.includes(bookNorm)) {
      score += 60;
      reasons.push("livre correspondant");
      if (verse.chapter === qChapter) {
        score += 50;
        reasons.push("chapitre correspondant");
      }
      if (qVerse && verse.verse === qVerse) {
        score += 80;
        reasons.push("verset exact");
      }
    }
  }

  // Exact contains bonuses
  if (q && textNorm.includes(q)) {
    score += 45;
    reasons.push("expression proche trouvée");
  }
  if (q && refNorm.includes(q)) {
    score += 45;
    reasons.push("référence proche trouvée");
  }

  // Token overlap (texte du verset uniquement — pas le nom du livre)
  const qTokens = tokenize(q).filter((t) => t.length >= 3);
  let tokenHits = 0;
  for (const tok of qTokens) {
    if (textHasWholeToken(textNorm, tok)) {
      tokenHits += 1;
      score += tok.length >= 5 ? 8 : 5;
    }
  }

  if (tokenHits > 0) {
    reasons.push(`${tokenHits} mot${tokenHits > 1 ? "s" : ""} en commun`);
  }

  return {
    score,
    tokenHits,
    reason:
      reasons[0] || "correspondance textuelle locale",
  };
}

function searchOffline(query, max = 3) {
  const q = normalize(query);
  const refMatch = q.match(/([1-3]?\s?[a-z]+)\s+(\d+)(?:\s*[:.]\s*(\d+))?/);
  const candidates = refMatch ? getCandidatePool(query) : VERSES;

  const ranked = candidates
    .map((v) => {
      const scored = scoreVerseLocal(query, v);
      return {
        ...v,
        score: scored.score,
        tokenHits: scored.tokenHits,
        reason: scored.reason,
      };
    })
    .filter((v) => v.score > 0)
    .sort((a, b) => b.tokenHits - a.tokenHits || b.score - a.score);

  const boosted = applyChapterBonuses(query, ranked);

  return boosted.slice(0, max).map((v) =>
    suggestionFromVerse(v, {
      reason: v.reason,
      score: v.score,
      tokenHits: v.tokenHits,
      source: v.score >= 90 ? "reference" : "lexical",
    })
  );
}

/** Clé de tri : d'abord mots en commun, puis score lexical ; sémantique en appoint. */
function lexicalSortKey(item) {
  if (item.source === "reference") {
    return [1000, item.tokenHits || 0, item.score || 0];
  }
  if (item.source === "lexical") {
    return [900, item.tokenHits || 0, item.score || 0];
  }
  return [0, 0, item.score || 0];
}

function compareSearchResults(a, b) {
  const ka = lexicalSortKey(a);
  const kb = lexicalSortKey(b);
  for (let i = 0; i < ka.length; i += 1) {
    if (kb[i] !== ka[i]) return kb[i] - ka[i];
  }
  return 0;
}

function mergeLexicalPriority(lexical, semantic, max) {
  const byRef = new Map();

  for (const item of lexical) {
    byRef.set(item.reference, item);
  }

  for (const item of semantic) {
    if (!byRef.has(item.reference)) {
      byRef.set(item.reference, item);
    }
  }

  return [...byRef.values()].sort(compareSearchResults).slice(0, max);
}

/** Embedding local (sentence-transformers) via le serveur Python. */
async function embedWithLocalServer(texts, type = "query") {
  const r = await fetch(`${LOCAL_EMBED_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts, type }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`Serveur embeddings local ${r.status}: ${detail.slice(0, 200)}`);
  }
  const data = await r.json();
  return data.embeddings || [];
}

/** Calcule l'embedding d'une requête selon le fournisseur actif. */
async function embedQuery(text) {
  const input = text.slice(0, 2000);
  if (EMBEDDING_PROVIDER === "local") {
    if (isNodeEmbedAvailable()) {
      const [vec] = await embedQueriesLocal([input], "query");
      if (!vec) throw new Error("Moteur sémantique local : réponse vide.");
      return Float32Array.from(vec);
    }
    try {
      const [vec] = await embedWithLocalServer([input], "query");
      if (!vec) throw new Error("Serveur embeddings local: réponse vide.");
      return Float32Array.from(vec);
    } catch (err) {
      const [vec] = await embedQueriesLocal([input], "query");
      if (!vec) throw err;
      return Float32Array.from(vec);
    }
  }
  if (!openai) {
    throw new Error("OPENAI_API_KEY manquant pour les embeddings OpenAI.");
  }
  const embRes = await openai.embeddings.create({
    model: OPENAI_EMBEDDING_MODEL,
    input,
  });
  return Float32Array.from(embRes.data[0].embedding);
}

async function searchSemantic(query, max = 5, { minSim = SEMANTIC_MIN_SIM } = {}) {
  if (!embeddingIndex || SEMANTIC_SEARCH === "off") {
    return [];
  }

  const qVec = await embedQuery(query);
  const { count, dimensions, vectors } = embeddingIndex;
  const scored = [];

  for (let idx = 0; idx < count; idx += 1) {
    const v = VERSES[idx];
    if (!v) continue;
    const vVec = vectors.subarray(idx * dimensions, idx * dimensions + dimensions);
    const sim = cosineSimilarity(qVec, vVec);
    if (sim < minSim) continue;
    scored.push({ v, sim });
  }

  scored.sort((a, b) => b.sim - a.sim);

  return scored.slice(0, max).map(({ v, sim }) => {
    const semanticPercent = Math.round(sim * 100);
    return suggestionFromVerse(v, {
      reason: `similarité sémantique ${semanticPercent}%`,
      score: similarityToScore(sim, "semantic"),
      semanticPercent,
      source: "semantic",
    });
  });
}

async function searchHybridOffline(query, max = 3, { minSemanticSim = SEMANTIC_MIN_SIM } = {}) {
  const lexical = searchOffline(query, max * 3);
  try {
    const semantic = await searchSemantic(query, max * 2, { minSim: minSemanticSim });
    return mergeLexicalPriority(lexical, semantic, max);
  } catch (err) {
    console.warn("Recherche sémantique:", err.message);
    return lexical.slice(0, max);
  }
}

/** Live : lexical d'abord ; sémantique si pas de référence forte (paraphrases). */
async function searchLive(query, max = 5) {
  const lexical = searchOffline(query, max * 2);
  const hasStrongLexical = lexical.some(
    (v) =>
      v.source === "reference" ||
      v.source === "chapter" ||
      (v.score || 0) >= 85
  );
  if (hasStrongLexical) {
    return { suggestions: lexical.slice(0, max), mode: "offline+live" };
  }

  const useSemantic = Boolean(embeddingIndex) && SEMANTIC_SEARCH !== "off";
  if (!useSemantic) {
    return { suggestions: lexical.slice(0, max), mode: "offline+live" };
  }

  try {
    const suggestions = await searchHybridOffline(query, max, {
      minSemanticSim: SEMANTIC_LIVE_MIN_SIM,
    });
    return { suggestions, mode: "offline+live+semantic" };
  } catch (err) {
    console.warn("Recherche live sémantique:", err.message);
    return { suggestions: lexical.slice(0, max), mode: "offline+live" };
  }
}

async function searchWithOpenAI(query, candidates) {
  if (!openai) {
    throw new Error(
      "OPENAI_API_KEY manquant. Utilise SEARCH_MODE=offline ou configure la clé."
    );
  }

    const candidatesPayload = candidates.map((v, i) => ({
      id: i,
    reference: buildReference(v),
      version: v.version,
      text: v.text,
    }));

    const systemPrompt = `Tu es un assistant de recherche biblique pour un régisseur d'église.
À partir d'une requête approximative (phrase entendue, référence, mot-clé), tu identifies 1 à 3 versets pertinents parmi la liste fournie.
Tu ne dois JAMAIS inventer de versets. Tu choisis uniquement parmi les candidats fournis.
Tu retournes un JSON strict de la forme :
{
  "suggestions": [
    { "id": <int>, "reason": "<courte justification en français>" }
  ]
}
Classe les suggestions par pertinence décroissante. Maximum 3.`;

    const userPrompt = `Requête du régisseur : "${query}"

Versets candidats :
${JSON.stringify(candidatesPayload, null, 2)}

Retourne les 1 à 3 versets les plus pertinents, au format JSON strict.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    });

    const raw = completion.choices[0].message.content;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
    throw new Error("Réponse IA non parsable.");
    }

  return (parsed.suggestions || [])
      .slice(0, 3)
    .map((s, idx) => {
        const verse = candidates[s.id];
        if (!verse) return null;
        return {
        reference: buildReference(verse),
          version: verse.version,
          text: verse.text,
          reason: s.reason || "",
        score: Math.max(55, 88 - idx * 12),
        source: "ai",
        };
      })
      .filter(Boolean);
}

function buildProPresenterBaseUrl(ip, port) {
  return `http://${ip}:${Number(port) || DEFAULT_PP_PORT}`;
}

async function readResponseBody(response) {
  const bodyText = await response.text();
  try {
    return { bodyText, bodyJson: JSON.parse(bodyText) };
  } catch {
    return { bodyText, bodyJson: null };
  }
}

/** ProPresenter 21+ : id est souvent { name, index, uuid }. */
function getMessageId(message) {
  const id = message?.id;
  if (id && typeof id === "object") {
    return id.uuid || (id.index != null ? String(id.index) : null);
  }
  if (id != null && id !== "") return String(id);
  return message?.uuid || null;
}

function getMessageName(message) {
  const id = message?.id;
  if (id && typeof id === "object" && id.name) {
    return id.name;
  }
  return (
    message?.name ||
    message?.title ||
    message?.message_name ||
    (typeof id === "string" ? id : null) ||
    "Sans nom"
  );
}

function resolveMessageIdParam(messageId) {
  if (messageId == null || messageId === "") return null;
  if (typeof messageId === "object") {
    return messageId.uuid || messageId.id || null;
  }
  const s = String(messageId).trim();
  if (!s || s === "[object Object]") return null;
  return s;
}

function normalizeMessagesList(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.messages)
    ? payload.messages
    : [];

  return list
    .map((m) => ({
      id: getMessageId(m),
      name: getMessageName(m),
      raw: m,
    }))
    .filter((m) => Boolean(m.id));
}

function summarizeMessage(m) {
  const raw = m.raw || m;
  const template = String(raw.message || "");
  const tokens = Array.isArray(raw.tokens) ? raw.tokens : [];
  return {
    id: m.id,
    name: m.name,
    template,
    tokenNames: tokens.map((t) => t.name).filter(Boolean),
    theme: raw.theme?.name || null,
    isActive: Boolean(raw.is_active),
  };
}

function messageIncludesToken(raw, tokenName) {
  if (!raw || !tokenName) return false;
  const target = normalize(tokenName);
  const template = String(raw.message || "");
  if (template.includes(`{${tokenName}}`)) return true;
  const tokens = Array.isArray(raw.tokens) ? raw.tokens : [];
  return tokens.some((t) => normalize(t.name) === target);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchMessages(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/messages`);
  const { bodyText, bodyJson } = await readResponseBody(response);

  if (!response.ok) {
    throw new Error(
      `GET /v1/messages a répondu ${response.status}${
        bodyText ? ` : ${bodyText}` : ""
      }`
    );
  }

  return normalizeMessagesList(bodyJson);
}

async function resolveMessageByName(baseUrl, messageName, messageIdParam) {
  const presetId = resolveMessageIdParam(messageIdParam);
  if (presetId) {
    return { id: presetId, name: messageName };
  }

  const messages = await fetchMessages(baseUrl);
  const normalizedTarget = normalize(messageName);
  const found = messages.find(
    (m) =>
      normalize(m.name) === normalizedTarget ||
      normalize(m.name).includes(normalizedTarget)
  );

  if (!found) {
    const err = new Error(`Message "${messageName}" introuvable dans ProPresenter.`);
    err.availableMessages = messages.map((m) => ({ id: m.id, name: m.name }));
    throw err;
  }

  return { id: found.id, name: found.name };
}

async function triggerProPresenterMessage(baseUrl, messageId, tokens) {
  const url = `${baseUrl}/v1/message/${encodeURIComponent(
    String(messageId)
  )}/trigger`;

  const ppResponse = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tokens),
  });

  const { bodyText } = await readResponseBody(ppResponse);

  if (!ppResponse.ok) {
    const err = new Error(`ProPresenter a répondu ${ppResponse.status}`);
    err.status = ppResponse.status;
    err.details = bodyText;
    err.url = url;
    throw err;
  }

  return { url, response: bodyText };
}

function decodeBase64Audio(audioBase64) {
  if (!audioBase64 || typeof audioBase64 !== "string") return null;
  const b64 = audioBase64.includes(",") ? audioBase64.split(",")[1] : audioBase64;
  return Buffer.from(b64, "base64");
}

/** Contexte du segment précédent (comme Pewbeam) pour limiter les hallucinations MLX. */
let mlxPreviousText = "";

function parseWavToMonoPcm16(wavBuffer, targetRate = 16000) {
  if (!wavBuffer || wavBuffer.length < 44) {
    throw new Error("Fichier WAV invalide ou trop court.");
  }
  if (wavBuffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Format audio non WAV.");
  }

  let fmtOffset = -1;
  let dataOffset = -1;
  let dataSize = 0;
  let offset = 12;

  while (offset + 8 <= wavBuffer.length) {
    const chunkId = wavBuffer.toString("ascii", offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);
    offset += 8;
    if (chunkId === "fmt ") fmtOffset = offset;
    if (chunkId === "data") {
      dataOffset = offset;
      dataSize = chunkSize;
      break;
    }
    offset += chunkSize + (chunkSize % 2);
  }

  if (fmtOffset < 0 || dataOffset < 0) {
    throw new Error("Chunks WAV fmt/data introuvables.");
  }

  const audioFormat = wavBuffer.readUInt16LE(fmtOffset);
  const channels = wavBuffer.readUInt16LE(fmtOffset + 2);
  const sampleRate = wavBuffer.readUInt32LE(fmtOffset + 4);
  const bitsPerSample = wavBuffer.readUInt16LE(fmtOffset + 14);

  if (audioFormat !== 1 || bitsPerSample !== 16) {
    throw new Error("Seul le PCM 16-bit est supporté pour MLX STT.");
  }

  const frameCount = Math.floor(dataSize / (channels * 2));
  const mono = Buffer.alloc(frameCount * 2);

  for (let i = 0; i < frameCount; i += 1) {
    const base = dataOffset + i * channels * 2;
    if (channels === 1) {
      mono[i * 2] = wavBuffer[base];
      mono[i * 2 + 1] = wavBuffer[base + 1];
    } else {
      let sum = 0;
      for (let ch = 0; ch < channels; ch += 1) {
        sum += wavBuffer.readInt16LE(base + ch * 2);
      }
      const avg = Math.round(sum / channels);
      mono.writeInt16LE(avg, i * 2);
    }
  }

  if (sampleRate === targetRate) return mono;

  const outFrames = Math.max(1, Math.floor((frameCount * targetRate) / sampleRate));
  const resampled = Buffer.alloc(outFrames * 2);
  for (let i = 0; i < outFrames; i += 1) {
    const srcPos = (i * sampleRate) / targetRate;
    const idx = Math.min(frameCount - 1, Math.floor(srcPos));
    const next = Math.min(frameCount - 1, idx + 1);
    const frac = srcPos - idx;
    const s0 = mono.readInt16LE(idx * 2);
    const s1 = mono.readInt16LE(next * 2);
    resampled.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
  }
  return resampled;
}

async function probeMlxStt() {
  try {
    const r = await fetch(`${MLX_STT_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` };
    const data = await r.json();
    return {
      ok: true,
      modelLoaded: Boolean(data.model_loaded),
      avgInferenceMs: data.avg_inference_ms ?? null,
    };
  } catch (err) {
    return { ok: false, detail: err.message || "indisponible" };
  }
}

async function transcribeWithMlx(wavBuffer) {
  const pcm16 = parseWavToMonoPcm16(wavBuffer, 16000);
  const useBiblicalHints =
    (process.env.MLX_STT_BIBLICAL_HINTS || "false").toLowerCase() === "true";
  const payload = {
    audio_b64: pcm16.toString("base64"),
    sample_rate: 16000,
    language: MLX_STT_LANG,
    use_biblical_hints: useBiblicalHints,
    previous_text:
      mlxPreviousText && !isSttRepetitiveHallucination(mlxPreviousText)
        ? mlxPreviousText
        : undefined,
  };

  const r = await fetch(`${MLX_STT_URL}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90000),
  });

  const raw = await r.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!r.ok) {
    throw new Error(
      (data && data.detail) ||
        (data && data.error) ||
        `MLX STT HTTP ${r.status}`
    );
  }

  let text = String(data?.text || "").trim();
  if (isSttRepetitiveHallucination(text)) {
    mlxPreviousText = "";
    return "";
  }
  if (text) {
    mlxPreviousText = `${mlxPreviousText} ${text}`.trim().slice(-400);
  }
  return text;
}

function whisperErrorText(err) {
  return `${err?.message || ""} ${err?.stderr || ""} ${err?.stdout || ""}`;
}

function isWhisperMetalCrash(err) {
  const msg = whisperErrorText(err);
  return msg.includes("GGML_ASSERT") || msg.includes("ggml-metal-device");
}

function isWhisperProcessFailure(err) {
  return whisperErrorText(err).includes("failed to process audio");
}

function buildWhisperArgs(inputPath, outBase, { useGpu }) {
  const args = [
    "-m",
    WHISPER_MODEL_PATH,
    "-f",
    inputPath,
    "-l",
    WHISPER_LANG,
    "-t",
    String(WHISPER_THREADS),
      "-bs",
      String(WHISPER_BEAM_SIZE),
    "--prompt",
    WHISPER_CPP_PROMPT,
    "-otxt",
    "-of",
    outBase,
    "-np",
  ];

  if (!useGpu) {
    args.push("-ng", "-nfa");
  }
  if (WHISPER_SUPPRESS_NST) args.push("-sns");
  if (WHISPER_CARRY_PROMPT) args.push("--carry-initial-prompt");
  if (WHISPER_USE_VAD) args.push("--vad");

  return args;
}

async function transcribeWithWhisperCpp(audioBuffer) {
  if (WHISPER_MODE !== "local") {
    throw new Error("WHISPER_MODE doit etre 'local' pour la transcription offline.");
  }

  if (!fs.existsSync(WHISPER_MODEL_PATH)) {
    throw new Error(
      `Modele whisper introuvable: ${WHISPER_MODEL_PATH}. Configure WHISPER_MODEL_PATH.`
    );
  }

  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "versepilot-"));
  const inputPath = path.join(tempRoot, "input.wav");
  const outBase = path.join(tempRoot, "output");
  const outTxt = `${outBase}.txt`;

  try {
    await fs.promises.writeFile(inputPath, audioBuffer);

    const useGpu = !WHISPER_NO_GPU;
    let whisperArgs = buildWhisperArgs(inputPath, outBase, { useGpu });

    const run = async (args) =>
      execFileAsync(WHISPER_BIN, args, {
        timeout: 45000,
        maxBuffer: 10 * 1024 * 1024,
      });

    try {
      await run(whisperArgs);
    } catch (err) {
      if (useGpu && isWhisperMetalCrash(err)) {
        console.warn("⚠️ Crash Metal Whisper detecte, retry en mode CPU (-ng).");
        whisperArgs = buildWhisperArgs(inputPath, outBase, { useGpu: false });
        await run(whisperArgs);
      } else if (WHISPER_USE_VAD && isWhisperProcessFailure(err)) {
        console.warn("⚠️ Whisper --vad en echec, retry sans VAD.");
        whisperArgs = buildWhisperArgs(inputPath, outBase, { useGpu: !WHISPER_NO_GPU }).filter(
          (a) => a !== "--vad"
        );
        await run(whisperArgs);
      } else {
        throw err;
      }
    }

    const text = (await fs.promises.readFile(outTxt, "utf-8")).trim();
    return text;
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new Error(
        `Binaire whisper introuvable (${WHISPER_BIN}). Installe whisper.cpp et configure WHISPER_BIN.`
      );
    }
    if (isWhisperMetalCrash(err) && !WHISPER_NO_GPU) {
      throw new Error(
        "Whisper a plante (GPU Metal). Mets WHISPER_NO_GPU=true dans backend/.env puis redemarre."
      );
    }
    if (isWhisperProcessFailure(err)) {
      throw new Error(
        "Whisper n'a pas pu traiter l'audio. Verifie le micro, puis reessaie (chunk plus court ou modele small)."
      );
    }
    throw new Error(err.message || "Transcription offline impossible.");
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
}

/** Boucles Whisper/MLX (ex. « produseur du délau » répété sur silence). */
function isSttRepetitiveHallucination(text) {
  if (!text || typeof text !== "string") return false;
  const tokens = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const n = tokens.length;
  if (n >= 8 && new Set(tokens.slice(-8)).size === 1) return true;
  if (n >= 12 && new Set(tokens).size / n < 0.2) return true;

  let prev = null;
  let runLen = 0;
  for (const token of tokens) {
    if (token === prev) {
      runLen += 1;
      if (runLen >= 6) return true;
    } else {
      prev = token;
      runLen = 1;
    }
  }
  return false;
}

function isSttPromptEcho(text) {
  const n = normalize(text);
  if (!n) return true;
  for (const phrase of STT_PROMPT_ECHO_PHRASES) {
    const p = normalize(phrase);
    if (!p) continue;
    if (n === p) return true;
    if (n.includes(p) && n.length <= p.length + 12) return true;
  }
  const stripped = stripSttPromptHallucination(text, { skipEchoCheck: true });
  return !stripped;
}

/** Retire l'écho du prompt STT (liste de livres, phrases Louis Segond, etc.). */
function stripSttPromptHallucination(text, opts = {}) {
  let out = String(text || "").trim();
  if (!out) return out;

  for (const phrase of STT_PROMPT_ECHO_PHRASES) {
    const escaped = escapeRegex(phrase);
    out = out.replace(new RegExp(escaped, "gi"), " ");
  }
  if (OPENAI_TRANSCRIBE_PROMPT) {
    out = out.replace(new RegExp(escapeRegex(OPENAI_TRANSCRIBE_PROMPT), "gi"), " ");
  }

  out = out.replace(
    /Bible française Louis Segond,?\s*versets bibliques,?\s*référence livre chapitre verset\.?\s*/gi,
    " "
  );
  out = out.replace(
    /\bPrédication en français\.?\s*(Lecture biblique Louis Segond\.?\s*)?/gi,
    " "
  );
  out = out.replace(/\bLecture biblique Louis Segond\.?\s*/gi, " ");
  out = out.replace(/\bversets bibliques\b/gi, " ");
  out = out.replace(/\bréférence livre chapitre verset\b/gi, " ");

  if (BIBLE_BOOKS.length) {
    const names = [...BIBLE_BOOKS]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegex);
    const bookRunRe = new RegExp(`(?:\\b(?:${names.join("|")})\\b\\s*){3,}`, "gi");
    out = out.replace(bookRunRe, " ");
  }

  const parts = out
    .split(/\s{2,}|(?<=[.!?])\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > 1) {
    const bookNorms = new Set(BIBLE_BOOKS.map((b) => normalize(b)));
    const kept = parts.filter((chunk) => {
      const words = chunk.split(/\s+/).filter((w) => w.length > 1);
      if (words.length < 4) return true;
      let bookHits = 0;
      for (const w of words) {
        const nw = normalize(w);
        if ([...bookNorms].some((b) => b === nw || b.includes(nw) || nw.includes(b))) {
          bookHits += 1;
        }
      }
      return bookHits / words.length < 0.55;
    });
    if (kept.length) out = kept.join(" ");
  }

  out = out.replace(/\s+/g, " ").trim();
  if (!opts.skipEchoCheck && !out) return "";
  return out;
}

function cleanupTranscribedText(text) {
  if (isSttKnownHallucination(text)) return "";
  if (isSttRepetitiveHallucination(text)) return "";
  if (isSttPromptEcho(text)) return "";
  let out = stripSttPromptHallucination(text);
  if (!out || isSttPromptEcho(out) || isSttRepetitiveHallucination(out)) return "";

  // Ignore common non-speech tags and noise markers from transcription models.
  out = out.replace(/\[[^\]]+\]/g, " ");
  out = out.replace(/\*[^*]+\*/g, " ");

  // Remove common filler words in FR speech.
  out = out.replace(/\b(euh|hum|hein|bah|ben)\b/gi, " ");

  for (const [pattern, value] of BOOK_ALIASES) {
    out = out.replace(pattern, value);
  }

  out = applyBiblicalLexicon(out);

  out = out.replace(/\s+/g, " ").trim();
  return out;
}

function correctBiblicalSpeech(text) {
  const base = String(text || "").trim();
  if (!base) return base;
  return applyBiblicalLexicon(base).replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// POST /search-verse
// Body: { query: string }
// Returns: { suggestions: [{ reference, version, text, reason }] }
// ---------------------------------------------------------------------------
// GET /bible/versions — liste des JSON disponibles (un fichier par version)
app.get("/bible/versions", (req, res) => {
  const versions = listAvailableBibles();
  return res.json({
    ok: true,
    active: activeBibleSlug,
    activeName: BIBLE_META.name,
    verseCount: VERSES.length,
    versions,
  });
});

app.post("/bible/select", (req, res) => {
  try {
    const { version } = req.body;
    if (!version || typeof version !== "string") {
      return res.status(400).json({ error: "Champ 'version' requis." });
    }
    const ok = loadBible(String(version).trim());
    if (!ok) {
      return res.status(404).json({
        error: `Version « ${version} » introuvable. Utilisez « Installer les Bibles » dans l'application.`,
        needsBibleImport: true,
      });
    }
    bibleIndexCache.clear();
    return res.json({
      ok: true,
      active: activeBibleSlug,
      activeName: BIBLE_META.name,
      verseCount: VERSES.length,
      embeddingIndexReady: Boolean(embeddingIndex),
      semanticSearchEnabled: SEMANTIC_SEARCH !== "off",
      embeddingProvider: EMBEDDING_PROVIDER,
      embeddingHint: embeddingIndex
        ? null
        : SEMANTIC_SEARCH === "off"
          ? null
          : `Index sémantique absent — requis pour les citations sans référence en live. Utilisez « Générer l'index sémantique ».`,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Changement de bible impossible." });
  }
});

app.get("/bible/import/status", (_req, res) => {
  res.json({
    ok: true,
    ...bibleImportState,
    installedCount: countInstalledBibles(),
  });
});

app.post("/bible/import", async (req, res) => {
  if (process.env.VERSEPILOT_PACKAGED === "1") {
    return res.status(403).json({
      error: "Les Bibles sont déjà incluses dans l'application installée.",
    });
  }
  if (bibleImportState.running) {
    return res.status(409).json({
      error: "Un import est déjà en cours.",
      ...bibleImportState,
    });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const slugs = Array.isArray(body.slugs)
    ? body.slugs.map((s) => String(s).trim()).filter(Boolean)
    : [];

  bibleImportState = {
    running: true,
    progress: {
      phase: "starting",
      message: "Préparation de l'import…",
      current: 0,
      total: slugs.length || null,
    },
    error: null,
    result: null,
  };

  res.json({
    ok: true,
    started: true,
    message: slugs.length
      ? `Import de ${slugs.join(", ")}…`
      : "Import des Bibles recommandées…",
  });

  void (async () => {
    try {
      const result = await runBibleImport({
        slugs,
        onProgress: (progress) => {
          bibleImportState.progress = progress;
        },
      });
      bibleIndexCache.clear();
      const preferred =
        result.versions.find((v) => v.slug === DEFAULT_BIBLE_SLUG)?.slug ||
        result.versions[0]?.slug;
      if (preferred) {
        try {
          loadBible(preferred);
        } catch (err) {
          console.warn("Rechargement bible après import:", err.message);
        }
      }
      bibleImportState = {
        running: false,
        progress: {
          phase: "done",
          message: `${result.completeCount} bible(s) installée(s).`,
        },
        error: null,
        result,
      };
    } catch (err) {
      bibleImportState = {
        running: false,
        progress: null,
        error: err.message || "Import impossible.",
        result: null,
      };
    }
  })();
});

app.get("/bible/embeddings/status", (_req, res) => {
  res.json({
    ok: true,
    ...embeddingBuildState,
    embeddingIndexReady: Boolean(embeddingIndex),
    needsEmbeddingBuild: needsEmbeddingIndex(),
    semanticSearch: SEMANTIC_SEARCH,
    embeddingProvider: EMBEDDING_PROVIDER,
    localEmbedServerRunning: Boolean(localEmbedServerProcess),
  });
});

app.post("/bible/embeddings/build", async (req, res) => {
  if (process.env.VERSEPILOT_PACKAGED === "1") {
    return res.status(403).json({
      error: "L'index sémantique est déjà inclus dans l'application installée.",
    });
  }
  if (SEMANTIC_SEARCH === "off") {
    return res.status(400).json({
      error: "Recherche sémantique désactivée (SEMANTIC_SEARCH=off).",
    });
  }
  if (embeddingBuildState.running) {
    return res.status(409).json({
      error: "Une génération d'index est déjà en cours.",
      ...embeddingBuildState,
    });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const slugs = Array.isArray(body.slugs)
    ? body.slugs.map((s) => String(s).trim()).filter(Boolean)
    : [activeBibleSlug];
  const provider =
    body.provider === "local" || body.provider === "openai"
      ? body.provider
      : EMBEDDING_PROVIDER;

  if (provider === "openai" && !process.env.OPENAI_API_KEY) {
    return res.status(400).json({
      error:
        "OPENAI_API_KEY manquante. Utilisez SEMANTIC_SEARCH=local ou configurez une clé OpenAI.",
    });
  }

  embeddingBuildState = {
    running: true,
    progress: {
      phase: "starting",
      message: "Préparation de l'index sémantique…",
      slug: slugs[0],
    },
    error: null,
    result: null,
  };

  res.json({
    ok: true,
    started: true,
    slugs,
    provider,
    message: `Génération de l'index sémantique (${provider})…`,
  });

  void (async () => {
    try {
      if (provider === "local") {
        embeddingBuildState.progress = {
          phase: "warmup",
          message: "Démarrage du moteur d'embeddings local…",
        };
        await ensureLocalEmbedServer();
      }

      const result = await runBuildEmbeddings({
        slugs,
        provider,
        onProgress: (progress) => {
          embeddingBuildState.progress = progress;
        },
      });

      const ready = reloadEmbeddingIndex(slugs[0] || activeBibleSlug);
      embeddingBuildState = {
        running: false,
        progress: {
          phase: "done",
          message: ready
            ? "Index sémantique prêt — citations par le sens activées en live."
            : "Index généré — rechargez la bible si besoin.",
        },
        error: null,
        result: { ...result, indexReady: ready },
      };
    } catch (err) {
      embeddingBuildState = {
        running: false,
        progress: null,
        error: err.message || "Génération impossible.",
        result: null,
      };
    }
  })();
});

// GET /bible/verse — verset dans une version (sans changer la bible active de recherche)
app.get("/bible/verse", (req, res) => {
  try {
    const slug = String(req.query.version || activeBibleSlug).trim();
    const book = String(req.query.book || "").trim();
    const chapter = parseInt(req.query.chapter, 10);
    const verse = parseInt(req.query.verse, 10);
    if (!book || !chapter || !verse) {
      return res.status(400).json({ error: "Paramètres book, chapter, verse requis." });
    }
    const v = lookupVerseInSlug(slug, book, chapter, verse);
    if (!v) {
      return res.status(404).json({ error: "Verset introuvable dans cette version." });
    }
    const index = getBibleIndexForSlug(slug);
    return res.json({
      ok: true,
      ...suggestionFromVerse(v),
      versionSlug: slug,
      versionName: index?.meta?.name || v.version || slug,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Lecture impossible." });
  }
});

// GET /bible/context — ±N versets autour d'une référence
app.get("/bible/context", (req, res) => {
  try {
    const slug = String(req.query.version || activeBibleSlug).trim();
    let book = String(req.query.book || "").trim();
    let chapter = parseInt(req.query.chapter, 10);
    let verse = parseInt(req.query.verse, 10);
    const radius = Math.min(12, Math.max(1, parseInt(req.query.radius, 10) || 3));

    if ((!book || !chapter || !verse) && req.query.reference) {
      const parsed = parseReferenceString(req.query.reference);
      if (parsed) {
        book = parsed.book;
        chapter = parsed.chapter;
        verse = parsed.verse;
      }
    }
    if (!book || !chapter || !verse) {
      return res.status(400).json({
        error: "Paramètres book/chapter/verse ou reference requis.",
      });
    }

    const ctx = getBibleContext(slug, book, chapter, verse, radius);
    if (!ctx) {
      return res.status(404).json({ error: "Contexte introuvable." });
    }
    return res.json({ ok: true, ...ctx });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Contexte impossible." });
  }
});

function lookupVerseByRef(book, chapter, verse) {
  const idx = verseIndexByKey.get(verseKey({ book, chapter, verse }));
  if (idx === undefined) return null;
  const v = VERSES[idx];
  return suggestionFromVerse(v, {
    score: 98,
    tokenHits: 0,
    source: "reference",
  });
}

function lookupChapterFirstVerse(book, chapter) {
  const bookNorm = normalize(book);
  const pool = versesByBookNorm.get(bookNorm) || [];
  const v = pool.find((x) => x.chapter === chapter);
  if (!v) return null;
  return lookupVerseByRef(v.book, chapter, v.verse);
}

// POST /detect-references — références directes dans la transcription
app.post("/detect-references", (req, res) => {
  try {
    const { text, context, version } = req.body || {};
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.json({ hits: [], context: context || {} });
    }

    if (version && version !== activeBibleSlug) {
      const ok = loadBible(String(version));
      if (!ok) {
        return res.status(404).json({ error: `Version « ${version} » introuvable.` });
      }
    }

    const correctedText = correctBiblicalSpeech(text);
    const { hits, context: nextContext } = detectDirectReferences(correctedText, {
      books: BIBLE_BOOKS,
      normalize,
      context: context || {},
      lookupVerse: lookupVerseByRef,
      lookupChapterFirstVerse,
    });

    return res.json({
      ok: true,
      hits,
      context: nextContext,
      correctedText: correctedText !== text.trim() ? correctedText : undefined,
      bibleVersion: activeBibleSlug,
    });
  } catch (err) {
    console.error("detect-references error:", err);
    return res.status(500).json({ error: err.message || "Détection impossible." });
  }
});

app.post("/search-verse", async (req, res) => {
  try {
    const { query, version, live } = req.body;
    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return res.status(400).json({ error: "Champ 'query' requis." });
    }

    const rawQuery = query.trim();
    const correctedQuery = correctBiblicalSpeech(rawQuery);

    if (version && version !== activeBibleSlug) {
      const ok = loadBible(String(version));
      if (!ok) {
        return res.status(404).json({
          error: `Version « ${version} » introuvable. Utilisez « Installer les Bibles » dans l'application.`,
          needsBibleImport: true,
        });
      }
    }

    const bibleInfo = {
      version: activeBibleSlug,
      versionName: BIBLE_META.name,
      versionCode: BIBLE_META.code,
    };

    const searchQuery = correctedQuery || rawQuery;
    const lexiconMeta =
      correctedQuery && correctedQuery !== rawQuery
        ? { rawQuery, correctedQuery }
        : undefined;

    const isLive = live === true || live === "true";
    if (isLive) {
      const { suggestions, mode: liveMode } = await searchLive(searchQuery, 5);
      return res.json({
        suggestions,
        mode: liveMode,
        ...bibleInfo,
        ...lexiconMeta,
      });
    }

    const useSemantic = Boolean(embeddingIndex) && SEMANTIC_SEARCH !== "off";
    const offlineSuggestions = useSemantic
      ? await searchHybridOffline(searchQuery, 5)
      : searchOffline(searchQuery, 3);
    const offlineMode = useSemantic ? "offline+semantic" : "offline";

    if (SEARCH_MODE === "offline") {
      return res.json({
        suggestions: offlineSuggestions,
        mode: offlineMode,
        ...bibleInfo,
        ...lexiconMeta,
      });
    }

    if (SEARCH_MODE === "hybrid") {
      if (offlineSuggestions.length > 0) {
        return res.json({
          suggestions: offlineSuggestions,
          mode: offlineMode,
          ...bibleInfo,
          ...lexiconMeta,
        });
      }
      const candidates = prefilterCandidates(searchQuery, 25);
      const suggestions = await searchWithOpenAI(searchQuery, candidates);
      return res.json({ suggestions, mode: "ai", ...bibleInfo, ...lexiconMeta });
    }

    // ai mode
    const candidates = prefilterCandidates(searchQuery, 25);
    const suggestions = await searchWithOpenAI(searchQuery, candidates);
    return res.json({ suggestions, mode: "ai", ...bibleInfo, ...lexiconMeta });
  } catch (err) {
    console.error("search-verse error:", err);
    return res.status(500).json({ error: err.message || "Erreur serveur." });
  }
});

// ---------------------------------------------------------------------------
// POST /send-to-propresenter
// Body: {
//   ip: string, port: number,
//   dualMessages?: boolean,      // deux messages PP distincts (réf. puis verset)
//   messageName?: string,        // message verset (défaut: "Verset")
//   messageId?: string,
//   refMessageName?: string,     // message référence (défaut: "Reference")
//   refMessageId?: string,
//   refTokenName?: string,       // default: "Reference"
//   textTokenName?: string,      // default: "Verset"
//   reference: string,
//   text: string
// }
// Forwards the verse to ProPresenter's HTTP API (Messages > Trigger).
// ---------------------------------------------------------------------------
app.post("/send-to-propresenter", async (req, res) => {
  try {
    const {
      ip,
      port,
      dualMessages = false,
      messageName = "Verset",
      messageId,
      refMessageName = "Reference",
      refMessageId,
      refTokenName = "Reference",
      textTokenName = "Verset",
      reference,
      text,
    } = req.body;

    if (!ip || !port || !reference || !text) {
      return res
        .status(400)
        .json({ error: "Champs requis : ip, port, reference, text." });
    }

    const baseUrl = buildProPresenterBaseUrl(ip, port);

    if (dualMessages) {
      const dualMessageOrder = String(
        req.body.dualMessageOrder || "verse-first"
      ).toLowerCase();
      const dualDelayMs = Math.min(
        800,
        Math.max(0, Number(req.body.dualDelayMs) || 220)
      );

      let refMsg;
      let verseMsg;
      let allMessages;
      try {
        allMessages = await fetchMessages(baseUrl);
        refMsg = await resolveMessageByName(
          baseUrl,
          refMessageName,
          refMessageId
        );
        verseMsg = await resolveMessageByName(baseUrl, messageName, messageId);
      } catch (err) {
        if (err.availableMessages) {
          return res.status(404).json({
            error: err.message,
            availableMessages: err.availableMessages,
          });
        }
        throw err;
      }

      const verseRaw =
        allMessages.find((m) => m.id === verseMsg.id)?.raw || null;
      const refRaw = allMessages.find((m) => m.id === refMsg.id)?.raw || null;

      const refTokens = [{ name: refTokenName, text: { text: reference } }];
      const verseTokens = [{ name: textTokenName, text: { text } }];

      // Le message « Verset » ne doit pas ré-afficher la référence en mode dual.
      if (messageIncludesToken(verseRaw, refTokenName)) {
        verseTokens.push({ name: refTokenName, text: { text: "" } });
      }
      if (messageIncludesToken(refRaw, textTokenName)) {
        refTokens.push({ name: textTokenName, text: { text: "" } });
      }

      const triggerRef = () =>
        triggerProPresenterMessage(baseUrl, refMsg.id, refTokens);
      const triggerVerse = () =>
        triggerProPresenterMessage(baseUrl, verseMsg.id, verseTokens);

      let refTrigger;
      let verseTrigger;
      if (dualMessageOrder === "reference-first") {
        refTrigger = await triggerRef();
        if (dualDelayMs) await sleep(dualDelayMs);
        verseTrigger = await triggerVerse();
      } else {
        verseTrigger = await triggerVerse();
        if (dualDelayMs) await sleep(dualDelayMs);
        refTrigger = await triggerRef();
      }

      const setupHints = [];
      if (messageIncludesToken(verseRaw, refTokenName)) {
        setupHints.push(
          `Le message « ${verseMsg.name} » contient aussi le jeton {${refTokenName}} : retire-le du modèle ProPresenter pour un affichage séparé propre.`
        );
      }

      return res.json({
        ok: true,
        mode: "dual",
        dualMessageOrder,
        setupHints: setupHints.length ? setupHints : undefined,
        triggers: [
          {
            role: "reference",
            messageName: refMsg.name,
            messageId: refMsg.id,
            ...refTrigger,
          },
          {
            role: "verse",
            messageName: verseMsg.name,
            messageId: verseMsg.id,
            ...verseTrigger,
          },
        ],
      });
    }

    const verseMsg = await resolveMessageByName(baseUrl, messageName, messageId);
    const single = await triggerProPresenterMessage(baseUrl, verseMsg.id, [
      { name: refTokenName, text: { text: reference } },
      { name: textTokenName, text: { text } },
    ]);

    return res.json({
      ok: true,
      mode: "single",
      url: single.url,
      messageId: verseMsg.id,
      messageName: verseMsg.name,
      response: single.response,
    });
  } catch (err) {
    console.error("send-to-propresenter error:", err);
    if (err.url) {
      return res.status(502).json({
        error: err.message,
        details: err.details,
        url: err.url,
      });
    }
    return res
      .status(500)
      .json({ error: err.message || "Connexion ProPresenter impossible." });
  }
});

async function transcribeWithDeepgram(audioBuffer) {
  if (LICENSE_CONFIG.enabled) {
    const r = await fetch(`${LICENSE_CONFIG.proxyUrl}/v1/transcribe`, {
      method: "POST",
      headers: {
        "X-VersePilot-License": LICENSE_CONFIG.licenseKey,
        "Content-Type": "audio/wav",
      },
      body: audioBuffer,
      signal: AbortSignal.timeout(25000),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      throw new Error(data?.error || `Proxy licence HTTP ${r.status}`);
    }
    return String(data?.transcript || "").trim();
  }

  if (!DEEPGRAM_API_KEY) {
    throw new Error(
      "DEEPGRAM_API_KEY manquant. Configure DEEPGRAM_API_KEY ou VERSEPILOT_LICENSE_KEY + VERSEPILOT_PROXY_URL."
    );
  }

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

  const r = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: "POST",
    headers: {
      Authorization: `Token ${DEEPGRAM_API_KEY}`,
      "Content-Type": "audio/wav",
    },
    body: audioBuffer,
    signal: AbortSignal.timeout(20000),
  });

  const raw = await r.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!r.ok) {
    const msg =
      data?.err_msg ||
      data?.error ||
      data?.message ||
      `Deepgram HTTP ${r.status}`;
    throw new Error(msg);
  }

  const transcript =
    data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
  return String(transcript).trim();
}

async function transcribeWithOpenAI(audioBuffer) {
  if (!openai) {
    throw new Error("OPENAI_API_KEY manquant pour la transcription cloud.");
  }

  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "versepilot-openai-"));
  const inputPath = path.join(tempRoot, "chunk.wav");

  try {
    await fs.promises.writeFile(inputPath, audioBuffer);
    const request = {
      file: fs.createReadStream(inputPath),
      model: OPENAI_TRANSCRIBE_MODEL,
      language: WHISPER_LANG,
    };
    if (OPENAI_TRANSCRIBE_USE_PROMPT && OPENAI_TRANSCRIBE_PROMPT) {
      request.prompt = OPENAI_TRANSCRIBE_PROMPT;
    }
    const result = await openai.audio.transcriptions.create(request);

    return String(result.text || "").trim();
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
}

async function transcribeAudio(audioBuffer, mode = STT_MODE) {
  if (mode === "deepgram") {
    return {
      text: await transcribeWithDeepgram(audioBuffer),
      engine: "deepgram",
    };
  }

  if (mode === "mlx") {
    return {
      text: await transcribeWithMlx(audioBuffer),
      engine: "mlx",
    };
  }

  if (mode === "openai") {
    return {
      text: await transcribeWithOpenAI(audioBuffer),
      engine: "openai",
    };
  }

  if (mode === "hybrid") {
    if (isDeepgramAvailable(DEEPGRAM_API_KEY, LICENSE_CONFIG)) {
      try {
        return {
          text: await transcribeWithDeepgram(audioBuffer),
          engine: "deepgram",
        };
      } catch (dgErr) {
        console.warn("STT hybrid: Deepgram ->", dgErr.message);
      }
    }
    try {
      return {
        text: await transcribeWithMlx(audioBuffer),
        engine: "mlx",
      };
    } catch (mlxErr) {
      console.warn("STT hybrid: MLX ->", mlxErr.message);
    }
    try {
      return {
        text: await transcribeWithOpenAI(audioBuffer),
        engine: "openai",
      };
    } catch (err) {
      console.warn("STT hybrid: OpenAI -> whisper.cpp :", err.message);
      return {
        text: await transcribeWithWhisperCpp(audioBuffer),
        engine: "local",
      };
    }
  }

  return {
    text: await transcribeWithWhisperCpp(audioBuffer),
    engine: "local",
  };
}

async function handleTranscribeRequest(req, res, forcedMode) {
  try {
    const { audioBase64 } = req.body;
    const audioBuffer = decodeBase64Audio(audioBase64);
    if (!audioBuffer || audioBuffer.length === 0) {
      return res.status(400).json({ error: "audioBase64 requis." });
    }

    const mode = String(forcedMode || STT_MODE).toLowerCase();
    const { text, engine } = await transcribeAudio(audioBuffer, mode);
    const cleanedText = cleanupTranscribedText(text);

    return res.json({
      ok: true,
      text: cleanedText,
      rawText: text,
      engine,
      mode,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Transcription impossible.",
    });
  }
}

// ---------------------------------------------------------------------------
// POST /transcribe
// Body: { audioBase64: string }
// Uses STT_MODE: deepgram | mlx | openai | local | hybrid
// ---------------------------------------------------------------------------
app.post("/transcribe", (req, res) => handleTranscribeRequest(req, res));

app.post("/stt/warmup", async (_req, res) => {
  try {
    const r = await fetch(`${MLX_STT_URL}/warmup`, {
      method: "POST",
      signal: AbortSignal.timeout(120000),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (err) {
    return res.status(503).json({
      error: err.message || "Serveur MLX STT indisponible. Lance npm run mlx-stt.",
    });
  }
});

// ---------------------------------------------------------------------------
// POST /transcribe-offline
// Body: { audioBase64: string } where audio is a WAV payload
// Always local whisper.cpp
// ---------------------------------------------------------------------------
app.post("/transcribe-offline", (req, res) =>
  handleTranscribeRequest(req, res, "local")
);

// ---------------------------------------------------------------------------
// GET /propresenter/health
// Query: ?ip=127.0.0.1&port=50001
// Checks basic connectivity and version endpoint.
// ---------------------------------------------------------------------------
app.get("/propresenter/health", async (req, res) => {
  try {
    const ip = String(req.query.ip || "").trim();
    const port = Number(req.query.port) || DEFAULT_PP_PORT;
    if (!ip) {
      return res.status(400).json({ error: "Paramètre 'ip' requis." });
    }

    const baseUrl = buildProPresenterBaseUrl(ip, port);
    const response = await fetch(`${baseUrl}/version`);
    const { bodyText, bodyJson } = await readResponseBody(response);

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: `ProPresenter a répondu ${response.status}`,
        details: bodyText,
        baseUrl,
      });
    }

    return res.json({
      ok: true,
      baseUrl,
      version: bodyJson || bodyText || null,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Connexion ProPresenter impossible.",
    });
  }
});

// ---------------------------------------------------------------------------
// GET /propresenter/messages
// Query: ?ip=127.0.0.1&port=50001
// Returns available messages for UI debug/selection.
// ---------------------------------------------------------------------------
app.get("/propresenter/messages", async (req, res) => {
  try {
    const ip = String(req.query.ip || "").trim();
    const port = Number(req.query.port) || DEFAULT_PP_PORT;
    if (!ip) {
      return res.status(400).json({ error: "Paramètre 'ip' requis." });
    }

    const baseUrl = buildProPresenterBaseUrl(ip, port);
    const messages = await fetchMessages(baseUrl);

    return res.json({
      ok: true,
      baseUrl,
      count: messages.length,
      messages: messages.map((m) => summarizeMessage(m)),
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Récupération des messages impossible.",
    });
  }
});

// ---------------------------------------------------------------------------
// POST /propresenter/clear
// Body: { ip, port, messageId?, messageName?, all? }
// Masque un message précis, ou toute la couche "messages" si all=true.
// ---------------------------------------------------------------------------
app.post("/propresenter/clear", async (req, res) => {
  try {
    const { ip, port, messageId, messageName, all = false } = req.body || {};
    if (!ip || !port) {
      return res.status(400).json({ error: "Champs requis : ip, port." });
    }

    const baseUrl = buildProPresenterBaseUrl(ip, port);

    if (all || (!messageId && !messageName)) {
      const url = `${baseUrl}/v1/clear/layer/messages`;
      const ppResponse = await fetch(url);
      const { bodyText } = await readResponseBody(ppResponse);
    if (!ppResponse.ok) {
      return res.status(502).json({
        error: `ProPresenter a répondu ${ppResponse.status}`,
        details: bodyText,
        url,
      });
      }
      return res.json({ ok: true, mode: "layer", url });
    }

    let resolved;
    try {
      resolved = await resolveMessageByName(baseUrl, messageName, messageId);
  } catch (err) {
      if (err.availableMessages) {
        return res.status(404).json({
          error: err.message,
          availableMessages: err.availableMessages,
        });
      }
      throw err;
    }

    const url = `${baseUrl}/v1/message/${encodeURIComponent(
      String(resolved.id)
    )}/clear`;
    const ppResponse = await fetch(url);
    const { bodyText } = await readResponseBody(ppResponse);
    if (!ppResponse.ok) {
      return res.status(502).json({
        error: `ProPresenter a répondu ${ppResponse.status}`,
        details: bodyText,
        url,
      });
    }

    return res.json({
      ok: true,
      mode: "message",
      messageId: resolved.id,
      messageName: resolved.name,
      url,
    });
  } catch (err) {
    console.error("propresenter/clear error:", err);
    return res
      .status(500)
      .json({ error: err.message || "Masquage ProPresenter impossible." });
  }
});

// Health check
app.get("/health", async (req, res) => {
  const mlxProbe = await probeMlxStt();
  res.json({
    ok: true,
    verses: VERSES.length,
    bibleVersion: activeBibleSlug,
    bibleName: BIBLE_META.name,
    bibleVersionsAvailable: countInstalledBibles(),
    biblesInstalled: countInstalledBibles() > 0,
    needsBibleImport: countInstalledBibles() === 0 || activeBibleSlug === "sample",
    bibleImportRunning: bibleImportState.running,
    searchMode: SEARCH_MODE,
    semanticSearch: SEMANTIC_SEARCH,
    embeddingIndexReady: Boolean(embeddingIndex),
    needsEmbeddingBuild: needsEmbeddingIndex(),
    embeddingBuildRunning: embeddingBuildState.running,
    clientBundleReady:
      countInstalledBibles() > 0 &&
      activeBibleSlug !== "sample" &&
      (SEMANTIC_SEARCH === "off" || Boolean(embeddingIndex)),
    isPackagedApp: process.env.VERSEPILOT_PACKAGED === "1",
    semanticLiveEnabled:
      Boolean(embeddingIndex) && SEMANTIC_SEARCH !== "off",
    semanticLiveMinSim: SEMANTIC_LIVE_MIN_SIM,
    embeddingProvider: EMBEDDING_PROVIDER,
    embeddingModel:
      EMBEDDING_PROVIDER === "local" ? LOCAL_EMBED_MODEL : OPENAI_EMBEDDING_MODEL,
    localEmbedUrl: LOCAL_EMBED_URL,
    sttMode: STT_MODE,
    deepgramConfigured: isDeepgramAvailable(DEEPGRAM_API_KEY, LICENSE_CONFIG),
    licenseMode: LICENSE_CONFIG.enabled,
    licenseConfigured: Boolean(LICENSE_CONFIG.licenseKey),
    proxyUrl: LICENSE_CONFIG.proxyUrl || null,
    deepgramModel: DEEPGRAM_MODEL,
    deepgramLanguage: DEEPGRAM_LANGUAGE,
    streamingAvailable: STREAMING_AVAILABLE,
    deepgramKeywords: DEEPGRAM_KEYWORDS_ENABLED,
    mlxSttUrl: MLX_STT_URL,
    mlxSttAvailable: mlxProbe.ok,
    mlxSttModelLoaded: mlxProbe.modelLoaded ?? false,
    mlxSttAvgInferenceMs: mlxProbe.avgInferenceMs,
    openAITranscribeModel: OPENAI_TRANSCRIBE_MODEL,
    openAIConfigured: Boolean(process.env.OPENAI_API_KEY),
    biblicalLexicon: getLexiconStats(),
    sttCloudReady:
      isDeepgramAvailable(DEEPGRAM_API_KEY, LICENSE_CONFIG) ||
      (Boolean(process.env.OPENAI_API_KEY) && STT_MODE !== "local"),
    whisperConfigured:
      WHISPER_MODE === "local" &&
      Boolean(WHISPER_BIN) &&
      fs.existsSync(WHISPER_MODEL_PATH),
    whisperBeamSize: WHISPER_BEAM_SIZE,
    whisperModel: path.basename(WHISPER_MODEL_PATH),
    whisperPromptConfigured: Boolean(WHISPER_CPP_PROMPT),
    openaiTranscribeUsePrompt: OPENAI_TRANSCRIBE_USE_PROMPT,
    openaiTranscribePromptChars: OPENAI_TRANSCRIBE_PROMPT.length,
    whisperVad: WHISPER_USE_VAD,
    whisperNoGpu: WHISPER_NO_GPU,
  });
});

// Always return JSON on JSON parsing errors (prevents empty/non-JSON responses).
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "JSON invalide dans la requete." });
  }
  return next(err);
});

// ---------------------------------------------------------------------------
// Streaming STT : relais WebSocket navigateur <-> Deepgram Listen (live).
// Le navigateur envoie du PCM 16 bits / 16 kHz mono ; on relaie tel quel.
// ---------------------------------------------------------------------------
function buildDeepgramStreamUrl(sampleRate = 16000) {
  const params = new URLSearchParams({
    model: DEEPGRAM_MODEL,
    language: DEEPGRAM_LANGUAGE,
    encoding: "linear16",
    sample_rate: String(sampleRate),
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    punctuate: "true",
    endpointing: "300",
    vad_events: "true",
  });
  if (DEEPGRAM_KEYWORDS_ENABLED) {
    for (const term of DEEPGRAM_BIBLE_KEYTERMS) {
      params.append("keywords", `${term}:2`);
    }
  }
  return `wss://api.deepgram.com/v1/listen?${params}`;
}

function attachSttStream(server) {
  const wss = new WebSocketServer({ server, path: "/stt/stream" });

  wss.on("connection", (client, req) => {
    if (!isDeepgramAvailable(DEEPGRAM_API_KEY, LICENSE_CONFIG)) {
      client.send(
        JSON.stringify({
          type: "error",
          error:
            "STT cloud indisponible : configure DEEPGRAM_API_KEY ou VERSEPILOT_LICENSE_KEY + VERSEPILOT_PROXY_URL.",
        })
      );
      client.close();
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const sampleRate = Number(url.searchParams.get("sampleRate")) || 16000;

    const upstreamUrl = LICENSE_CONFIG.enabled
      ? `${proxyWsUrl(LICENSE_CONFIG.proxyUrl)}?sampleRate=${sampleRate}`
      : buildDeepgramStreamUrl(sampleRate);
    const upstreamHeaders = LICENSE_CONFIG.enabled
      ? { "X-VersePilot-License": LICENSE_CONFIG.licenseKey }
      : { Authorization: `Token ${DEEPGRAM_API_KEY}` };

    const dg = new WebSocket(upstreamUrl, { headers: upstreamHeaders });

    let dgOpen = false;
    const audioBacklog = [];
    let keepAlive = null;

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
        client.send(
          JSON.stringify({ type: "error", error: `Deepgram: ${err.message}` })
        );
      }
    });

    dg.on("close", () => {
      if (keepAlive) clearInterval(keepAlive);
      if (client.readyState === WebSocket.OPEN) client.close();
    });

    client.on("message", (data, isBinary) => {
      if (isBinary) {
        if (dgOpen && dg.readyState === WebSocket.OPEN) {
          dg.send(data);
        } else {
          audioBacklog.push(data);
        }
        return;
      }
      // Message texte de contrôle (ex: finalize/close).
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

  console.log("🔌 STT streaming WebSocket prêt sur /stt/stream");
}

const httpServer = http.createServer(app);
attachSttStream(httpServer);
httpServer.listen(PORT, () => {
  console.log(`✅ VersePilot Live backend ready on http://localhost:${PORT}`);
  if (STREAMING_AVAILABLE) {
    console.log("🎧 Streaming Deepgram disponible (mode temps réel).");
  }
});
