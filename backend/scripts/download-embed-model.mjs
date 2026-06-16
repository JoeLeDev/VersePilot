#!/usr/bin/env node
/**
 * Télécharge le modèle Xenova/multilingual-e5-small dans backend/models/transformers
 * pour embarquement hors-ligne dans l'installeur client.
 */
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "models", "transformers");

async function main() {
  process.env.TRANSFORMERS_CACHE = CACHE_DIR;
  const { pipeline, env } = await import("@xenova/transformers");
  env.cacheDir = CACHE_DIR;
  env.allowLocalModels = true;
  console.log("→ Téléchargement Xenova/multilingual-e5-small…");
  console.log(`   Cache : ${CACHE_DIR}`);
  await pipeline("feature-extraction", "Xenova/multilingual-e5-small", {
    quantized: true,
  });
  console.log("✅ Modèle prêt pour la livraison client.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
