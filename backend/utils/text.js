export function normalize(str) {
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

export function tokenize(str) {
  return normalize(str)
    .split(" ")
    .filter((t) => t.length >= 2);
}

export function buildReference(v) {
  return `${v.book} ${v.chapter}:${v.verse}`;
}

export function verseCoords(v) {
  return { book: v.book, chapter: v.chapter, verse: v.verse };
}

export function suggestionFromVerse(v, extra = {}) {
  return {
    reference: buildReference(v),
    version: v.version,
    text: v.text,
    ...verseCoords(v),
    ...extra,
  };
}

/** Parse "Jean 3:16" → { book, chapter, verse } */
export function parseReferenceString(ref) {
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

export function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function textHasWholeToken(textNorm, tok) {
  if (!tok || tok.length < 3) return false;
  return new RegExp(`\\b${escapeRegex(tok)}\\b`, "i").test(textNorm);
}

export function booksMatch(qBook, bookNorm) {
  if (!qBook || !bookNorm) return false;
  return bookNorm.includes(qBook) || qBook.includes(bookNorm);
}
