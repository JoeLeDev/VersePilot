import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseReferenceString } from "../utils/text.js";
import { searchOffline } from "../services/searchService.js";

const SAMPLE_VERSES = [
  {
    book: "Jean",
    chapter: 3,
    verse: 16,
    text: "Car Dieu a tant aimé le monde qu'il a donné son Fils unique.",
    version: "LSG",
  },
  {
    book: "Jean",
    chapter: 3,
    verse: 17,
    text: "Dieu n'a pas envoyé son Fils pour condamner le monde.",
    version: "LSG",
  },
  {
    book: "Psaumes",
    chapter: 23,
    verse: 1,
    text: "L'Éternel est mon berger: je ne manquerai de rien.",
    version: "LSG",
  },
];

const versesByBookNorm = new Map([
  ["jean", SAMPLE_VERSES.filter((v) => v.book === "Jean")],
  ["psaumes", SAMPLE_VERSES.filter((v) => v.book === "Psaumes")],
]);

describe("parseReferenceString", () => {
  it("parse une référence standard", () => {
    assert.deepEqual(parseReferenceString("Jean 3:16"), {
      book: "Jean",
      chapter: 3,
      verse: 16,
    });
  });

  it("retourne null si format invalide", () => {
    assert.equal(parseReferenceString("jean trois seize"), null);
    assert.equal(parseReferenceString(""), null);
  });
});

describe("searchOffline", () => {
  it("trouve Jean 3:16 par référence", () => {
    const results = searchOffline(
      "Jean 3:16",
      SAMPLE_VERSES,
      versesByBookNorm,
      3
    );
    assert.ok(results.length >= 1);
    assert.equal(results[0].reference, "Jean 3:16");
  });

  it("trouve un verset par mots du texte", () => {
    const results = searchOffline(
      "berger je ne manquerai",
      SAMPLE_VERSES,
      versesByBookNorm,
      3
    );
    assert.ok(results.some((r) => r.book === "Psaumes"));
  });
});
