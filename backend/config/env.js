import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { getLicenseConfig } from "../lib/versepilot-license.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");

export function loadEnv() {
  const envFile =
    process.env.VERSEPILOT_ENV_FILE || path.join(backendRoot, ".env");
  dotenv.config({ path: envFile });
  return envFile;
}

const VALID_SEARCH_MODES = new Set(["offline", "hybrid", "ai"]);
const VALID_STT_MODES = new Set([
  "local",
  "deepgram",
  "mlx",
  "openai",
  "hybrid",
]);
const VALID_SEMANTIC = new Set(["off", "openai", "local"]);

function warnIfInvalid(name, value, allowed) {
  if (!allowed.has(value)) {
    console.warn(
      `⚠ ${name}="${value}" invalide — valeurs : ${[...allowed].join(", ")}`
    );
  }
}

export function createConfig() {
  const license = getLicenseConfig();
  const searchMode = (process.env.SEARCH_MODE || "offline").toLowerCase();
  const sttMode = (process.env.STT_MODE || "local").toLowerCase();
  const semanticSearch = (process.env.SEMANTIC_SEARCH || "openai").toLowerCase();

  warnIfInvalid("SEARCH_MODE", searchMode, VALID_SEARCH_MODES);
  warnIfInvalid("STT_MODE", sttMode, VALID_STT_MODES);
  warnIfInvalid("SEMANTIC_SEARCH", semanticSearch, VALID_SEMANTIC);

  const deepgramKey = (process.env.DEEPGRAM_API_KEY || "").trim();
  const openaiKey = (process.env.OPENAI_API_KEY || "").trim();

  if (sttMode === "deepgram" && !deepgramKey && !license.enabled) {
    console.warn(
      "⚠ STT_MODE=deepgram sans DEEPGRAM_API_KEY ni VERSEPILOT_LICENSE_KEY"
    );
  }
  if (
    (searchMode === "ai" || searchMode === "hybrid") &&
    semanticSearch === "openai" &&
    !openaiKey
  ) {
    console.warn("⚠ SEARCH_MODE nécessite OPENAI_API_KEY pour le mode sémantique");
  }

  return {
    port: Number(process.env.PORT || 4000),
    backendRoot,
    biblesDir: path.join(backendRoot, "data", "bibles"),
    sampleVersesPath: path.join(backendRoot, "data", "verses.json"),
    defaultBibleSlug: process.env.BIBLE_VERSION || "louis-segond",
    searchMode,
    semanticSearch,
    embeddingProvider: semanticSearch === "local" ? "local" : "openai",
    openaiEmbeddingModel:
      process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
    localEmbedUrl: (
      process.env.LOCAL_EMBED_URL || "http://127.0.0.1:8003"
    ).replace(/\/$/, ""),
    localEmbedModel:
      process.env.LOCAL_EMBED_MODEL || "intfloat/multilingual-e5-small",
    sttMode,
    mlxSttUrl: (process.env.MLX_STT_URL || "http://127.0.0.1:8002").replace(
      /\/$/,
      ""
    ),
    mlxSttLang: process.env.MLX_STT_LANG || "fr",
    deepgramApiKey: deepgramKey,
    license,
    deepgramModel: process.env.DEEPGRAM_MODEL || "nova-3",
    deepgramLanguage: process.env.DEEPGRAM_LANGUAGE || "fr",
    deepgramKeywordsEnabled:
      (process.env.DEEPGRAM_KEYWORDS_ENABLED || "false").toLowerCase() ===
      "true",
    defaultPpPort: 50001,
    openaiApiKey: openaiKey,
  };
}
