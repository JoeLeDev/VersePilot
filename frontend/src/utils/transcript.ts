// Helpers purs de traitement du texte de transcription (STT).
// Extraits de App.tsx pour être typés et testables indépendamment.

export const LAST_PHRASE_MAX_WORDS = 12;

/** Détecte une hallucination STT répétitive (même mot/segment répété en boucle). */
export function isSttRepetitiveHallucination(text: string): boolean {
  if (!text) return false;
  const tokens = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const n = tokens.length;
  if (n >= 8 && new Set(tokens.slice(-8)).size === 1) return true;
  if (n >= 12 && new Set(tokens).size / n < 0.2) return true;
  let prev: string | null = null;
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

/** Vrai si `addition` est déjà présente (en fin) dans `transcript`. */
export function isDuplicateTranscriptAddition(
  addition: string,
  transcript: string
): boolean {
  const add = addition.trim().toLowerCase();
  if (!add || add.length < 12) return false;
  const full = transcript.trim().toLowerCase();
  if (!full) return false;
  if (full.endsWith(add)) return true;
  const lastPhrase = extractLastPhrase(transcript).trim().toLowerCase();
  if (lastPhrase && lastPhrase === add) return true;
  if (add.length >= 20 && full.includes(add)) {
    const tail = full.slice(-Math.min(full.length, add.length * 3));
    if (tail.split(add).length > 2) return true;
  }
  return false;
}

/** Détecte les hallucinations connues (génériques de sous-titrage, etc.). */
export function isSttKnownHallucination(text: string): boolean {
  const n = text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!n) return false;
  const exact = [
    "sous titrage societe radio canada",
    "sous titrage st 501",
    "merci d avoir regarde",
    "thank you for watching",
    "thanks for watching",
    "subtitles by the amara org community",
  ];
  if (exact.some((p) => n === p || n.includes(p))) return true;
  if (/sous\s*titrage/.test(n) && /radio\s*canada/.test(n)) return true;
  if (/sous\s*titrage/.test(n) && n.length < 80) return true;
  if (/merci\s+d\s*avoir\s+regard/.test(n)) return true;
  return false;
}

/** Vrai si le texte est un écho du prompt STT ou une hallucination. */
export function isSttPromptEchoText(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (isSttKnownHallucination(t)) return true;
  if (isSttRepetitiveHallucination(t)) return true;
  const n = t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    /^(?:predication en francais\.?\s*)?(?:lecture biblique louis segond\.?\s*)+$/.test(
      n
    )
  ) {
    return true;
  }
  if (
    n.includes("bible francaise louis segond") &&
    n.includes("versets bibliques") &&
    t.length < 220
  ) {
    return true;
  }
  return false;
}

/** Normalise un texte pour comparer des mots (minuscules, sans accents/ponctuation). */
export function normalizeMergeWords(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compte le chevauchement (en mots) entre la fin du transcript et le début du nouveau texte. */
export function countWordOverlap(
  transcriptWords: string[],
  newWords: string[],
  maxWords = 14
): number {
  if (!transcriptWords.length || !newWords.length) return 0;
  const limit = Math.min(maxWords, transcriptWords.length, newWords.length);
  for (let n = limit; n >= 2; n -= 1) {
    const suffix = normalizeMergeWords(transcriptWords.slice(-n).join(" "));
    const prefix = normalizeMergeWords(newWords.slice(0, n).join(" "));
    if (suffix && suffix === prefix) return n;
  }
  return 0;
}

/** Renvoie la dernière phrase (ou les `maxWords` derniers mots) du transcript. */
export function extractLastPhrase(
  transcript: string,
  maxWords = LAST_PHRASE_MAX_WORDS
): string {
  const t = transcript.trim();
  if (!t) return "";
  const parts = t.split(/(?<=[.!?…])\s+/).filter(Boolean);
  const lastSentence = (parts[parts.length - 1] || t).trim();
  const words = lastSentence.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return lastSentence;
  return words.slice(-maxWords).join(" ");
}

/** Sépare le transcript en `before` + dernière phrase mise en évidence. */
export function splitTranscriptHighlight(full: string): {
  before: string;
  last: string;
} {
  const last = extractLastPhrase(full);
  if (!last) return { before: full, last: "" };
  const idx = full.lastIndexOf(last);
  if (idx < 0) return { before: full, last: "" };
  return {
    before: full.slice(0, idx).trimEnd(),
    last,
  };
}
