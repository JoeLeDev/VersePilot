import { describe, expect, it } from "vitest";
import {
  countWordOverlap,
  extractLastPhrase,
  isDuplicateTranscriptAddition,
  isSttKnownHallucination,
  isSttPromptEchoText,
  isSttRepetitiveHallucination,
  normalizeMergeWords,
  splitTranscriptHighlight,
} from "./transcript";

describe("isSttRepetitiveHallucination", () => {
  it("détecte un mot répété en boucle", () => {
    expect(isSttRepetitiveHallucination("oui oui oui oui oui oui oui")).toBe(true);
  });
  it("laisse passer un texte normal", () => {
    expect(
      isSttRepetitiveHallucination("Car Dieu a tant aimé le monde qu'il a donné")
    ).toBe(false);
  });
  it("renvoie false sur texte vide", () => {
    expect(isSttRepetitiveHallucination("")).toBe(false);
  });
});

describe("isSttKnownHallucination", () => {
  it("détecte un générique de sous-titrage", () => {
    expect(isSttKnownHallucination("Sous-titrage Société Radio-Canada")).toBe(true);
  });
  it("détecte 'thanks for watching'", () => {
    expect(isSttKnownHallucination("Thanks for watching!")).toBe(true);
  });
  it("laisse passer un verset", () => {
    expect(isSttKnownHallucination("Au commencement était la Parole")).toBe(false);
  });
});

describe("isSttPromptEchoText", () => {
  it("considère un texte vide comme écho", () => {
    expect(isSttPromptEchoText("   ")).toBe(true);
  });
  it("détecte l'écho du prompt", () => {
    expect(isSttPromptEchoText("Lecture biblique Louis Segond.")).toBe(true);
  });
  it("laisse passer un vrai contenu", () => {
    expect(isSttPromptEchoText("Heureux les pauvres en esprit")).toBe(false);
  });
});

describe("normalizeMergeWords", () => {
  it("retire accents et ponctuation", () => {
    expect(normalizeMergeWords("Élevé, à l'Éternel!")).toBe("eleve a l'eternel");
  });
});

describe("extractLastPhrase", () => {
  it("renvoie la dernière phrase", () => {
    expect(extractLastPhrase("Bonjour à tous. Que la paix soit avec vous.")).toBe(
      "Que la paix soit avec vous."
    );
  });
  it("limite au nombre de mots demandé", () => {
    expect(extractLastPhrase("un deux trois quatre cinq", 3)).toBe("trois quatre cinq");
  });
  it("renvoie une chaîne vide si vide", () => {
    expect(extractLastPhrase("")).toBe("");
  });
});

describe("countWordOverlap", () => {
  it("trouve le chevauchement de fin/début", () => {
    const a = "il a donné son fils unique".split(" ");
    const b = "son fils unique afin que".split(" ");
    expect(countWordOverlap(a, b)).toBe(3);
  });
  it("renvoie 0 sans chevauchement", () => {
    expect(countWordOverlap(["a", "b"], ["c", "d"])).toBe(0);
  });
});

describe("isDuplicateTranscriptAddition", () => {
  it("détecte une addition déjà en fin de transcript", () => {
    expect(
      isDuplicateTranscriptAddition(
        "que la paix soit avec vous",
        "bonjour a tous que la paix soit avec vous"
      )
    ).toBe(true);
  });
  it("laisse passer une addition nouvelle", () => {
    expect(
      isDuplicateTranscriptAddition("un texte totalement different", "bonjour a tous")
    ).toBe(false);
  });
});

describe("splitTranscriptHighlight", () => {
  it("sépare le début et la dernière phrase", () => {
    const { before, last } = splitTranscriptHighlight(
      "Bonjour à tous. Que la paix soit avec vous."
    );
    expect(before).toBe("Bonjour à tous.");
    expect(last).toBe("Que la paix soit avec vous.");
  });
});
