import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  sendVerseToProPresenter,
  buildProPresenterBaseUrl,
} from "../services/propresenterService.js";

describe("buildProPresenterBaseUrl", () => {
  it("construit l'URL de base", () => {
    assert.equal(
      buildProPresenterBaseUrl("127.0.0.1", 49354),
      "http://127.0.0.1:49354"
    );
  });
});

describe("sendVerseToProPresenter", () => {
  it("rejette si champs manquants", async () => {
    await assert.rejects(
      () => sendVerseToProPresenter({ ip: "127.0.0.1" }),
      /Champs requis/
    );
  });

  it("envoie en mode single (mock fetch)", async () => {
    const originalFetch = global.fetch;
    global.fetch = mock.fn(async (url, opts) => {
      if (String(url).endsWith("/v1/messages")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify([
              { id: "msg-1", name: "Verset", message: "{Verset}" },
            ]),
        };
      }
      if (String(url).includes("/trigger")) {
        assert.equal(opts.method, "POST");
        return { ok: true, text: async () => "ok" };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    try {
      const result = await sendVerseToProPresenter({
        ip: "127.0.0.1",
        port: 49354,
        reference: "Jean 3:16",
        text: "Car Dieu a tant aimé le monde.",
        messageName: "Verset",
      });
      assert.equal(result.mode, "single");
      assert.equal(result.ok, true);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
