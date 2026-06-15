import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { normalizeText } from "./text-normalize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEXICON_PATH = path.join(__dirname, "..", "data", "biblical-lexicon.json");

let lexiconData = null;
/** @type {Map<string, { canonical: string, type: string, wordCount: number }>} */
let phraseMap = new Map();

function loadLexiconFile() {
  if (lexiconData) return lexiconData;
  if (!fs.existsSync(LEXICON_PATH)) {
    lexiconData = { version: 1, entryCount: 0, entries: [] };
    phraseMap = new Map();
    return lexiconData;
  }
  lexiconData = JSON.parse(fs.readFileSync(LEXICON_PATH, "utf-8"));
  buildPhraseMap(lexiconData.entries || []);
  return lexiconData;
}

function isUnsafeAlias(aliasKey, canonicalKey) {
  if (!aliasKey || aliasKey === canonicalKey) return true;
  const canonicalWords = canonicalKey.split(" ").filter(Boolean);
  if (canonicalWords.length > 1 && canonicalWords.includes(aliasKey)) return true;
  if (aliasKey.length < 4 && canonicalKey.includes(aliasKey)) return true;
  return false;
}

function buildPhraseMap(entries) {
  const map = new Map();

  for (const entry of entries) {
    const canonical = String(entry.canonical || "").trim();
    if (!canonical) continue;
    const canonicalKey = normalizeText(canonical);
    const wordCount = canonicalKey.split(" ").filter(Boolean).length;
    const meta = {
      canonical,
      type: entry.type || "terme",
      wordCount,
    };

    const aliases = new Set([canonical, ...(entry.aliases || [])]);
    for (const alias of aliases) {
      const aliasKey = normalizeText(alias);
      if (!aliasKey || aliasKey === canonicalKey) continue;
      if (isUnsafeAlias(aliasKey, canonicalKey)) continue;
      if (aliasKey.length < 2) continue;

      const existing = map.get(aliasKey);
      if (!existing || wordCount > existing.wordCount) {
        map.set(aliasKey, meta);
      }
    }
  }

  phraseMap = map;
}

const MAX_WINDOW = 6;

/**
 * Corrige les noms bibliques mal transcrits avant recherche / détection.
 * Ex. « méfie bauchette » → « Méphibosheth »
 */
export function applyBiblicalLexicon(text, { track = false } = {}) {
  const input = String(text || "");
  if (!input.trim()) return track ? { text: input, corrections: [] } : input;

  loadLexiconFile();
  if (!phraseMap.size) {
    return track ? { text: input, corrections: [] } : input;
  }

  const rawWords = input.match(/\S+/g) || [];
  if (!rawWords.length) return track ? { text: input, corrections: [] } : input;

  const normWords = rawWords.map((w) => normalizeText(w));
  const corrections = [];
  const out = [];
  let i = 0;

  while (i < rawWords.length) {
    let matched = false;

    for (let len = Math.min(MAX_WINDOW, rawWords.length - i); len >= 1; len--) {
      const phraseKey = normWords.slice(i, i + len).join(" ");
      const hit = phraseMap.get(phraseKey);
      if (!hit) continue;

      const fromText = rawWords.slice(i, i + len).join(" ");
      out.push(hit.canonical);
      if (track && normalizeText(fromText) !== normalizeText(hit.canonical)) {
        corrections.push({ from: fromText, to: hit.canonical, type: hit.type });
      }
      i += len;
      matched = true;
      break;
    }

    if (!matched) {
      out.push(rawWords[i]);
      i += 1;
    }
  }

  const result = out.join(" ").replace(/\s+/g, " ").trim();
  return track ? { text: result, corrections } : result;
}

export function getLexiconStats() {
  const data = loadLexiconFile();
  return {
    loaded: Boolean(data.entryCount),
    entryCount: data.entryCount || (data.entries || []).length,
    aliasCount: phraseMap.size,
    generatedAt: data.generatedAt || null,
    path: LEXICON_PATH,
  };
}

export function reloadBiblicalLexicon() {
  lexiconData = null;
  phraseMap = new Map();
  return getLexiconStats();
}
