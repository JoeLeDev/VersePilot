// Helpers purs autour des versets (pagination, score, tags, références).
// Extraits de App.tsx pour être typés et testables indépendamment.
import type { ConfidenceTier, Verse, VerseRef } from "../types";

/** Découpe un verset trop long en pages, sans couper les mots. */
export function splitVerseIntoPages(text: string, maxChars = 220): string[] {
  const clean = (text || "").trim();
  const limit = Number(maxChars) > 0 ? Number(maxChars) : 220;
  if (!clean || clean.length <= limit) return [clean];
  const words = clean.split(/\s+/);
  const pages: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > limit) {
      pages.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) pages.push(cur);
  return pages;
}

/** Libellé court de la nature du score (sémantique, référence, mots…). */
export function verseScoreLabel(verse: Verse): string {
  if (verse.source === "semantic") {
    const pct =
      verse.semanticPercent ??
      (verse.reason?.match(/(\d+)\s*%/)?.[1]
        ? Number(verse.reason.match(/(\d+)\s*%/)![1])
        : null);
    return pct != null ? `${pct}% sens` : "Sémantique";
  }
  if (verse.source === "reference") return "Référence";
  if (verse.tokenHits) {
    return `${verse.tokenHits} mot${verse.tokenHits > 1 ? "s" : ""}`;
  }
  return "Texte";
}

/** Formate un timestamp en heure locale FR (HH:MM:SS). */
export function formatDetectionTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Libellé lisible d'une source de détection. */
export function detectionSourceLabel(source?: string): string {
  if (source === "reference") return "Référence";
  if (source === "chapter") return "Chapitre";
  if (source === "citation") return "Citation";
  if (source === "semantic") return "Sémantique";
  if (source === "lexical") return "Mots";
  return "Texte";
}

/** Score 0-100 d'un verset (score lexical/IA, sinon similarité sémantique). */
export function verseScoreNumber(verse: Verse): number {
  if (typeof verse.score === "number" && verse.score > 0) {
    return Math.min(100, Math.round(verse.score));
  }
  if (typeof verse.semanticPercent === "number") {
    return Math.min(100, Math.round(verse.semanticPercent));
  }
  return 0;
}

/** Palier de confiance pour l'affichage (couleur + libellé). */
export function confidenceTier(score: number): ConfidenceTier {
  if (score >= 85) return { key: "confirmed", label: "Confirmé" };
  if (score >= 60) return { key: "probable", label: "Probable" };
  return { key: "hypothesis", label: "Hypothèse" };
}

/** Parse une référence "Livre C:V" en coordonnées, ou null si invalide. */
export function parseReference(ref?: string): VerseRef | null {
  const m = String(ref || "")
    .trim()
    .match(/^(.+?)\s+(\d+)\s*:\s*(\d+)\s*$/);
  if (!m) return null;
  return {
    book: m[1].trim(),
    chapter: Number(m[2]),
    verse: Number(m[3]),
  };
}

/** Complète les coordonnées (book/chapter/verse) d'un verset à partir de sa référence. */
export function ensureVerseCoords<T extends Verse | null | undefined>(
  verse: T
): T {
  if (!verse) return verse;
  if (verse.book && verse.chapter && verse.verse) return verse;
  const p = parseReference(verse.reference);
  return p ? ({ ...verse, ...p } as T) : verse;
}

/** Clé d'identité stable d'un verset (coordonnées, sinon référence). */
export function verseIdentityKey(verse: Verse): string {
  const v = ensureVerseCoords(verse);
  if (v.book && v.chapter && v.verse) {
    return `${v.book}|${v.chapter}|${v.verse}`;
  }
  return v.reference || "";
}

/** Tags courts dérivés de la source/des correspondances, sans inventer de data. */
export function verseTags(verse: Verse): string[] {
  const tags: string[] = [];
  if (verse.source === "reference" || verse.source === "chapter") {
    tags.push("référence");
  }
  if (verse.source === "semantic") tags.push("thème");
  if (verse.source === "citation") tags.push("citation");
  if (verse.source === "lexical") tags.push("mots-clés");
  if (verse.tokenHits) {
    tags.push(`${verse.tokenHits} mot${verse.tokenHits > 1 ? "s" : ""}`);
  }
  if (!tags.length) tags.push("texte");
  return tags.slice(0, 3);
}
