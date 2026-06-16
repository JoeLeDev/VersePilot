/**
 * Embeddings de requêtes en Node (sans Python) — pour l'app packagée client.
 * Utilise le même modèle e5 que l'index local pré-généré.
 */
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_ID = process.env.LOCAL_EMBED_MODEL || "intfloat/multilingual-e5-small";
const XENOVA_MODEL = "Xenova/multilingual-e5-small";

let extractor = null;
let loadError = null;

function modelCacheDir() {
  return (
    process.env.TRANSFORMERS_CACHE ||
    path.join(__dirname, "..", "models", "transformers")
  );
}

function prefixText(text, type = "query") {
  const t = String(text || "").trim();
  if (!t) return t;
  if (MODEL_ID.toLowerCase().includes("e5")) {
    return type === "query" ? `query: ${t}` : `passage: ${t}`;
  }
  return t;
}

export async function embedQueriesLocal(texts, type = "query") {
  if (loadError) throw new Error(loadError);
  try {
    if (!extractor) {
      const { pipeline, env } = await import("@xenova/transformers");
      env.cacheDir = modelCacheDir();
      env.allowLocalModels = true;
      env.allowRemoteModels = process.env.VERSEPILOT_PACKAGED !== "1";
      extractor = await pipeline("feature-extraction", XENOVA_MODEL, {
        quantized: true,
      });
    }

    const results = [];
    for (const text of texts) {
      const input = prefixText(text, type);
      const out = await extractor(input, { pooling: "mean", normalize: true });
      results.push(Array.from(out.data));
    }
    return results;
  } catch (err) {
    loadError = err.message || String(err);
    throw err;
  }
}

export function isNodeEmbedAvailable() {
  return process.env.VERSEPILOT_PACKAGED === "1" || process.env.EMBED_QUERY_MODE === "node";
}
