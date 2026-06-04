/**
 * Détection instantanée des références bibliques (style Pewbeam tier DIRECT).
 * Livres FR, chiffres parlés, contexte chapitre pour « verset 10 ».
 */

const SPOKEN_NUMBERS = {
  un: "1",
  une: "1",
  premier: "1",
  premiere: "1",
  deux: "2",
  deuxieme: "2",
  trois: "3",
  troisieme: "3",
  quatre: "4",
  cinq: "5",
  six: "6",
  sept: "7",
  huit: "8",
  neuf: "9",
  dix: "10",
  onze: "11",
  douze: "12",
  treize: "13",
  quatorze: "14",
  quinze: "15",
  seize: "16",
  dixsept: "17",
  dixhuit: "18",
  dixneuf: "19",
  vingt: "20",
};

const EXTRA_BOOK_ALIASES = {
  jn: "Jean",
  jean: "Jean",
  mt: "Matthieu",
  matthieu: "Matthieu",
  mc: "Marc",
  marc: "Marc",
  lc: "Luc",
  luc: "Luc",
  ac: "Actes",
  actes: "Actes",
  ap: "Apocalypse",
  apocalypse: "Apocalypse",
  apoc: "Apocalypse",
  ps: "Psaumes",
  psaume: "Psaumes",
  psaumes: "Psaumes",
  gen: "Genèse",
  genese: "Genèse",
  ex: "Exode",
  exode: "Exode",
  rm: "Romains",
  romains: "Romains",
  co: "1 Corinthiens",
  corinthiens: "1 Corinthiens",
  ga: "Galates",
  galates: "Galates",
  ep: "Éphésiens",
  eph: "Éphésiens",
  ephésiens: "Éphésiens",
  phil: "Philippiens",
  philippiens: "Philippiens",
  col: "Colossiens",
  colossiens: "Colossiens",
  he: "Hébreux",
  hebreux: "Hébreux",
  jg: "Jacques",
  jacques: "Jacques",
};

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expandSpokenNumbers(text) {
  let out = text;
  for (const [word, num] of Object.entries(SPOKEN_NUMBERS)) {
    out = out.replace(new RegExp(`\\b${word}\\b`, "gi"), num);
  }
  return out;
}

function cleanTranscriptText(text) {
  let t = String(text || "");
  const prefixes = [
    /\b(?:s'il vous pla[iî]t\s+)?(?:ouvrez|ouvre|tournez|tourne|allez|va|regardez|regarde|lisez|lis)\s+(?:vos?\s+bibles?\s+)?(?:a|à|au|en)?\s*/gi,
    /\b(?:nous\s+)?(?:lisons|lisez)\s+/gi,
  ];
  for (const p of prefixes) t = t.replace(p, "");
  return t.trim();
}

function buildBookAliasMap(books, normalize) {
  const map = new Map();
  const add = (alias, canonical) => {
    const key = normalize(alias);
    if (!key || key.length < 2) return;
    if (!map.has(key)) map.set(key, canonical);
  };

  for (const book of books) {
    add(book, book);
    const n = normalize(book);
    add(n, book);
    const noAccent = book
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    add(noAccent, book);
  }

  for (const [alias, canonical] of Object.entries(EXTRA_BOOK_ALIASES)) {
    if (books.includes(canonical)) add(alias, canonical);
  }

  return map;
}

function resolveBookName(raw, aliasMap, normalize) {
  const key = normalize(raw);
  return aliasMap.get(key) || null;
}

/**
 * @returns {{ hits: object[], context: { book?: string, chapter?: number } }}
 */
export function detectDirectReferences(text, options) {
  const {
    books = [],
    normalize,
    context = {},
    lookupVerse,
    lookupChapterFirstVerse,
  } = options;

  if (!text || !books.length || !normalize || !lookupVerse) {
    return { hits: [], context: { ...context } };
  }

  const aliasMap = buildBookAliasMap(books, normalize);
  const expanded = expandSpokenNumbers(cleanTranscriptText(text));
  const bookPattern = [...aliasMap.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|");

  if (!bookPattern) return { hits: [], context: { ...context } };

  const hits = [];
  const seen = new Set();
  let ctx = { ...context };

  const pushHit = (payload) => {
    const key = payload.reference;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(payload);
    if (payload.book) ctx.book = payload.book;
    if (payload.chapter) ctx.chapter = payload.chapter;
  };

  const bookRe = new RegExp(`\\b(${bookPattern})\\b`, "gi");

  const reVerse = new RegExp(
    `\\b(${bookPattern})\\s+(\\d+)\\s*[:.\\s,-]+\\s*(\\d+)(?:\\s*[-–]\\s*(\\d+))?\\b`,
    "gi"
  );
  let m;
  while ((m = reVerse.exec(expanded)) !== null) {
    const book = resolveBookName(m[1], aliasMap, normalize);
    if (!book) continue;
    const chapter = parseInt(m[2], 10);
    const v1 = parseInt(m[3], 10);
    const v2 = m[4] ? parseInt(m[4], 10) : v1;
    for (let v = v1; v <= v2 && v <= v1 + 2; v += 1) {
      const verse = lookupVerse(book, chapter, v);
      if (!verse) continue;
      pushHit({
        ...verse,
        source: "reference",
        score: 98,
        matchedText: m[0],
        book,
        chapter,
        verse: v,
        reason: "référence directe entendue",
      });
    }
  }

  const reChapterVerse = new RegExp(
    `\\b(${bookPattern})\\s+(?:chapitre\\s+)?(\\d+)\\s+(?:verset\\s+)?(\\d+)\\b`,
    "gi"
  );
  while ((m = reChapterVerse.exec(expanded)) !== null) {
    const book = resolveBookName(m[1], aliasMap, normalize);
    if (!book) continue;
    const chapter = parseInt(m[2], 10);
    const v = parseInt(m[3], 10);
    const verse = lookupVerse(book, chapter, v);
    if (!verse) continue;
    pushHit({
      ...verse,
      source: "reference",
      score: 96,
      matchedText: m[0],
      book,
      chapter,
      verse: v,
      reason: "référence parlée (chapitre + verset)",
    });
  }

  const reChapter = new RegExp(
    `\\b(${bookPattern})\\s+(?:chapitre\\s+)?(\\d+)\\b`,
    "gi"
  );
  while ((m = reChapter.exec(expanded)) !== null) {
    const book = resolveBookName(m[1], aliasMap, normalize);
    if (!book) continue;
    const chapter = parseInt(m[2], 10);
    const refKey = `${book}|${chapter}|chapter`;
    if (seen.has(`${book} ${chapter}`)) continue;
    const sample =
      lookupChapterFirstVerse?.(book, chapter) ||
      lookupVerse(book, chapter, 1);
    if (!sample) continue;
    pushHit({
      ...sample,
      reference: `${book} ${chapter}`,
      source: "chapter",
      score: 82,
      matchedText: m[0],
      book,
      chapter,
      reason: "chapitre entendu",
    });
    seen.add(`${book} ${chapter}`);
    seen.add(refKey);
  }

  if (ctx.book && ctx.chapter) {
    const reVersetSeul = /\bverset\s+(\d{1,3})\b/gi;
    while ((m = reVersetSeul.exec(expanded)) !== null) {
      const v = parseInt(m[1], 10);
      const verse = lookupVerse(ctx.book, ctx.chapter, v);
      if (!verse) continue;
      pushHit({
        ...verse,
        source: "reference",
        score: 94,
        matchedText: m[0],
        book: ctx.book,
        chapter: ctx.chapter,
        verse: v,
        reason: `verset ${v} (contexte ${ctx.book} ${ctx.chapter})`,
      });
    }
  }

  return { hits, context: ctx };
}
