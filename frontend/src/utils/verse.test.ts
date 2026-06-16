import { describe, expect, it } from "vitest";
import {
  confidenceTier,
  detectionSourceLabel,
  ensureVerseCoords,
  splitVerseIntoPages,
  verseIdentityKey,
  verseScoreLabel,
  verseScoreNumber,
  verseTags,
} from "./verse";

describe("splitVerseIntoPages", () => {
  it("ne coupe pas un texte court", () => {
    expect(splitVerseIntoPages("Court", 220)).toEqual(["Court"]);
  });
  it("découpe sans couper les mots", () => {
    const pages = splitVerseIntoPages("alpha beta gamma delta", 11);
    expect(pages).toEqual(["alpha beta", "gamma delta"]);
  });
  it("retombe sur 220 si maxChars invalide", () => {
    expect(splitVerseIntoPages("abc", 0)).toEqual(["abc"]);
  });
});

describe("verseScoreNumber", () => {
  it("plafonne à 100", () => {
    expect(verseScoreNumber({ reference: "x", text: "y", score: 250 })).toBe(100);
  });
  it("utilise semanticPercent en repli", () => {
    expect(
      verseScoreNumber({ reference: "x", text: "y", semanticPercent: 73 })
    ).toBe(73);
  });
  it("renvoie 0 sans score", () => {
    expect(verseScoreNumber({ reference: "x", text: "y" })).toBe(0);
  });
});

describe("confidenceTier", () => {
  it("classe confirmé/probable/hypothèse", () => {
    expect(confidenceTier(90).key).toBe("confirmed");
    expect(confidenceTier(70).key).toBe("probable");
    expect(confidenceTier(30).key).toBe("hypothesis");
  });
});

describe("verseScoreLabel", () => {
  it("affiche le pourcentage sémantique", () => {
    expect(
      verseScoreLabel({ reference: "x", text: "y", source: "semantic", semanticPercent: 80 })
    ).toBe("80% sens");
  });
  it("compte les mots", () => {
    expect(verseScoreLabel({ reference: "x", text: "y", tokenHits: 2 })).toBe("2 mots");
  });
});

describe("detectionSourceLabel", () => {
  it("traduit les sources connues", () => {
    expect(detectionSourceLabel("reference")).toBe("Référence");
    expect(detectionSourceLabel("lexical")).toBe("Mots");
    expect(detectionSourceLabel("inconnu")).toBe("Texte");
  });
});

describe("ensureVerseCoords", () => {
  it("complète les coordonnées depuis la référence", () => {
    const v = ensureVerseCoords({ reference: "Jean 3:16", text: "..." });
    expect(v).toMatchObject({ book: "Jean", chapter: 3, verse: 16 });
  });
  it("laisse intact si déjà coordonné", () => {
    const input = { reference: "x", text: "y", book: "Jean", chapter: 3, verse: 16 };
    expect(ensureVerseCoords(input)).toBe(input);
  });
});

describe("verseIdentityKey", () => {
  it("construit une clé par coordonnées", () => {
    expect(verseIdentityKey({ reference: "Jean 3:16", text: "..." })).toBe("Jean|3|16");
  });
});

describe("verseTags", () => {
  it("limite à 3 tags", () => {
    const tags = verseTags({ reference: "x", text: "y", source: "lexical", tokenHits: 4 });
    expect(tags.length).toBeLessThanOrEqual(3);
    expect(tags).toContain("mots-clés");
  });
  it("renvoie 'texte' par défaut", () => {
    expect(verseTags({ reference: "x", text: "y" })).toEqual(["texte"]);
  });
});
