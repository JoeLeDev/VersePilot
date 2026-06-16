import { describe, expect, it } from "vitest";
import { apiUrl, wsUrl } from "./api";

// En environnement jsdom, window.location.protocol vaut "http:" → API_BASE = "".

describe("apiUrl", () => {
  it("préfixe le chemin (base vide en dev)", () => {
    expect(apiUrl("/health")).toBe("/health");
  });
});

describe("wsUrl", () => {
  it("construit une URL ws sur l'hôte courant", () => {
    expect(wsUrl("/stt/stream")).toMatch(/^wss?:\/\/.+\/stt\/stream$/);
  });
});
