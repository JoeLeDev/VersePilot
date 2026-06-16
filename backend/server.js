// VersePilot Live — Backend
// Express server: fuzzy Bible verse search via OpenAI + ProPresenter dispatch.

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
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
import { searchOffline as searchOfflineCore } from "./services/searchService.js";
import { parseReferenceString } from "./utils/text.js";
import { safeError } from "./utils/safeLog.js";
import { createProPresenterRouter } from "./routes/propresenterRoutes.js";
import { createSttService } from "./services/sttService.js";
import { createSttRouter } from "./routes/sttRoutes.js";

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
    sttService.onBibleUpdated();
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
    sttService.onBibleUpdated();
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
  sttService.probeMlxStt().then((p) => {
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

const sttService = createSttService({
  normalize,
  escapeRegex,
  applyBiblicalLexicon,
  getBibleBooks: () => BIBLE_BOOKS,
  licenseConfig: LICENSE_CONFIG,
  isDeepgramAvailable,
  proxyWsUrl,
  openai,
});

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
  return searchOfflineCore(query, VERSES, versesByBookNorm, max);
}

// parseReferenceString → utils/text.js

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
    const [vec] = await embedWithLocalServer([input], "query");
    if (!vec) throw new Error("Serveur embeddings local: réponse vide.");
    return Float32Array.from(vec);
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

async function searchSemantic(query, max = 5) {
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
    if (sim < 0.32) continue;
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

async function searchHybridOffline(query, max = 3) {
  const lexical = searchOffline(query, max * 3);
  try {
    const semantic = await searchSemantic(query, max * 2);
    return mergeLexicalPriority(lexical, semantic, max);
  } catch (err) {
    console.warn("Recherche sémantique:", err.message);
    return lexical.slice(0, max);
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

function correctBiblicalSpeech(text) {
  return sttService.correctBiblicalSpeech(text);
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
        error: `Version « ${version} » introuvable. Lance npm run import-bibles`,
      });
    }
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
        : `Index sémantique [${EMBEDDING_PROVIDER}] absent pour cette version. Lance: ${
            EMBEDDING_PROVIDER === "local"
              ? "npm run build-embeddings:local"
              : "npm run build-embeddings"
          }`,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Changement de bible impossible." });
  }
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
          error: `Version « ${version} » introuvable. Lance npm run import-bibles`,
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
      const suggestions = searchOffline(searchQuery, 5);
      return res.json({
        suggestions,
        mode: "offline+live",
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

app.use(createProPresenterRouter({ defaultPort: DEFAULT_PP_PORT }));
app.use(createSttRouter(sttService));

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
  try {
    const mlxProbe = await sttService.probeMlxStt();
    res.json({
      ok: true,
      verses: VERSES.length,
      bibleVersion: activeBibleSlug,
      bibleName: BIBLE_META.name,
      bibleVersionsAvailable: listAvailableBibles().length,
      searchMode: SEARCH_MODE,
      semanticSearch: SEMANTIC_SEARCH,
      embeddingIndexReady: Boolean(embeddingIndex),
      embeddingProvider: EMBEDDING_PROVIDER,
      embeddingModel:
        EMBEDDING_PROVIDER === "local" ? LOCAL_EMBED_MODEL : OPENAI_EMBEDDING_MODEL,
      localEmbedUrl: LOCAL_EMBED_URL,
      sttMode: sttService.sttMode,
      deepgramConfigured: sttService.deepgramConfigured,
      licenseMode: LICENSE_CONFIG.enabled,
      licenseConfigured: Boolean(LICENSE_CONFIG.licenseKey),
      proxyUrl: LICENSE_CONFIG.proxyUrl || null,
      deepgramModel: sttService.deepgramModel,
      deepgramLanguage: sttService.deepgramLanguage,
      streamingAvailable: sttService.streamingAvailable,
      deepgramKeywords: sttService.deepgramKeywords,
      mlxSttUrl: sttService.mlxSttUrl,
      mlxSttAvailable: mlxProbe.ok,
      mlxSttModelLoaded: mlxProbe.modelLoaded ?? false,
      mlxSttAvgInferenceMs: mlxProbe.avgInferenceMs,
      openAITranscribeModel: sttService.openAITranscribeModel,
      openAIConfigured: sttService.openAIConfigured,
      biblicalLexicon: getLexiconStats(),
      sttCloudReady: sttService.sttCloudReady,
      whisperConfigured: sttService.whisperConfigured,
      whisperBeamSize: sttService.whisperBeamSize,
      whisperModel: sttService.whisperModel,
      whisperPromptConfigured: sttService.whisperPromptConfigured,
      openaiTranscribeUsePrompt: sttService.openaiTranscribeUsePrompt,
      openaiTranscribePromptChars: sttService.openaiTranscribePromptChars,
      whisperVad: sttService.whisperVad,
      whisperNoGpu: sttService.whisperNoGpu,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message || "Health check impossible.",
    });
  }
});

// Always return JSON on JSON parsing errors (prevents empty/non-JSON responses).
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "JSON invalide dans la requete." });
  }
  return next(err);
});

const httpServer = http.createServer(app);
sttService.attachSttStream(httpServer);
httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n✗ Port ${PORT} déjà utilisé. Un autre backend tourne peut-être encore.\n` +
        `  macOS/Linux : lsof -ti :${PORT} | xargs kill -9\n` +
        `  Puis relance : npm run dev\n`
    );
    process.exit(1);
  }
  console.error("✗ Erreur serveur HTTP :", err.message);
  process.exit(1);
});
httpServer.listen(PORT, () => {
  console.log(`✅ VersePilot Live backend ready on http://localhost:${PORT}`);
  if (sttService.streamingAvailable) {
    console.log("🎧 Streaming Deepgram disponible (mode temps réel).");
  } else if (sttService.sttMode === "mlx") {
    console.log(
      "ℹ️  STT_MODE=mlx sans streaming Deepgram — lance : npm run mlx-stt --prefix backend"
    );
  }
});
