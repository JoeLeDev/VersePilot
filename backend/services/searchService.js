import {
  normalize,
  buildReference,
  suggestionFromVerse,
  textHasWholeToken,
  booksMatch,
} from "../utils/text.js";

export function getCandidatePool(query, verses, versesByBookNorm) {
  const q = normalize(query);
  if (!q) return verses.slice(0, 200);

  const refMatch = q.match(/([1-3]?\s?[a-z]+)\s+(\d+)(?:\s*[:.]\s*(\d+))?/);
  if (refMatch) {
    const refBook = normalize(refMatch[1]);
    const refChapter = parseInt(refMatch[2], 10);
    const pool = [];
    for (const [bookNorm, bookVerses] of versesByBookNorm.entries()) {
      if (bookNorm.includes(refBook) || refBook.includes(bookNorm)) {
        for (const v of bookVerses) {
          if (!refChapter || v.chapter === refChapter) pool.push(v);
        }
      }
    }
    if (pool.length) return pool;
  }

  const tokens = q.split(" ").filter((t) => t.length >= 3);
  if (!tokens.length) return verses.slice(0, 200);

  const pool = [];
  for (const v of verses) {
    const haystack = normalize(`${v.book} ${v.chapter}:${v.verse} ${v.text}`);
    if (tokens.some((tok) => haystack.includes(tok))) pool.push(v);
    if (pool.length >= 800) break;
  }
  return pool.length ? pool : verses.slice(0, 200);
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

export function scoreVerseLocal(query, verse) {
  const q = normalize(query);
  const ref = buildReference(verse);
  const refNorm = normalize(ref);
  const textNorm = normalize(verse.text || "");
  const bookNorm = normalize(verse.book || "");

  let score = 0;
  const reasons = [];

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

  if (q && textNorm.includes(q)) {
    score += 45;
    reasons.push("expression proche trouvée");
  }
  if (q && refNorm.includes(q)) {
    score += 45;
    reasons.push("référence proche trouvée");
  }

  const qTokens = q.split(" ").filter((t) => t.length >= 3);
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
    reason: reasons[0] || "correspondance textuelle locale",
  };
}

export function searchOffline(query, verses, versesByBookNorm, max = 3) {
  const q = normalize(query);
  const refMatch = q.match(/([1-3]?\s?[a-z]+)\s+(\d+)(?:\s*[:.]\s*(\d+))?/);
  const candidates = refMatch
    ? getCandidatePool(query, verses, versesByBookNorm)
    : verses;

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
