#!/usr/bin/env node
/**
 * Construit l'index d'embeddings pour une bible (1 fichier .bin + .meta.json).
 *
 * Usage:
 *   npm run build-embeddings              # bible active
 *   npm run build-embeddings -- darby
 *   npm run build-embeddings:local
 */

import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import dotenv from "dotenv";
import OpenAI from "openai";
import { verseKey, embeddingVariantSuffix } from "../lib/verse-embeddings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIBLES_DIR = path.join(__dirname, "..", "data", "bibles");

const OPENAI_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const LOCAL_EMBED_URL = (process.env.LOCAL_EMBED_URL || "http://127.0.0.1:8003").replace(
  /\/$/,
  ""
);
const LOCAL_EMBED_MODEL =
  process.env.LOCAL_EMBED_MODEL || "intfloat/multilingual-e5-small";

function verseInput(v) {
  const ref = `${v.book} ${v.chapter}:${v.verse}`;
  return `${ref}. ${v.text}`.slice(0, 2000);
}

async function embedBatchOpenAI(openai, inputs) {
  const res = await openai.embeddings.create({ model: OPENAI_MODEL, input: inputs });
  return [...res.data].sort((a, b) => a.index - b.index).map((row) => row.embedding);
}

async function embedBatchLocal(inputs) {
  const r = await fetch(`${LOCAL_EMBED_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts: inputs, type: "passage" }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`Serveur local ${r.status}: ${detail.slice(0, 300)}`);
  }
  const data = await r.json();
  return data.embeddings || [];
}

async function warmupLocalEmbedServer() {
  try {
    await fetch(`${LOCAL_EMBED_URL}/warmup`, { method: "POST", signal: AbortSignal.timeout(120000) });
    return true;
  } catch (err) {
    throw new Error(
      `Serveur d'embeddings local injoignable sur ${LOCAL_EMBED_URL}. ` +
        `Lance d'abord : npm run embed-server (${err.message})`
    );
  }
}

function resolveProvider(requested) {
  if (requested === "local" || requested === "openai") return requested;
  const semantic = (process.env.SEMANTIC_SEARCH || "openai").toLowerCase();
  if (semantic === "local") return "local";
  if (semantic === "off") return "openai";
  return semantic === "openai" ? "openai" : "local";
}

/**
 * @param {{ slugs?: string[], provider?: string, onProgress?: (p: object) => void }} opts
 */
export async function runBuildEmbeddings(opts = {}) {
  const slugs =
    opts.slugs?.length > 0
      ? opts.slugs
      : [process.env.BIBLE_VERSION || "louis-segond"];
  const provider = resolveProvider(opts.provider);
  const onProgress = opts.onProgress;
  const batchSize = Number(
    process.env.EMBEDDING_BATCH_SIZE || (provider === "local" ? 64 : 256)
  );

  let openai = null;
  if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        "OPENAI_API_KEY manquant. Configure la clé ou passe SEMANTIC_SEARCH=local."
      );
    }
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } else {
    onProgress?.({
      phase: "warmup",
      message: "Connexion au serveur d'embeddings local…",
    });
    await warmupLocalEmbedServer();
  }

  const modelLabel = provider === "local" ? LOCAL_EMBED_MODEL : OPENAI_MODEL;
  const suffix = embeddingVariantSuffix(provider);
  const built = [];

  for (let s = 0; s < slugs.length; s += 1) {
    const slug = slugs[s];
    const biblePath = path.join(BIBLES_DIR, `${slug}.json`);
    if (!fs.existsSync(biblePath)) {
      throw new Error(`Bible « ${slug} » introuvable. Installez-la d'abord.`);
    }

    const payload = JSON.parse(fs.readFileSync(biblePath, "utf-8"));
    const verses = payload.verses || payload;
    if (!verses.length) {
      throw new Error(`${slug} : aucun verset dans le fichier.`);
    }

    onProgress?.({
      phase: "building",
      slug,
      current: s + 1,
      total: slugs.length,
      verseCount: verses.length,
      batch: 0,
      totalBatches: Math.ceil(verses.length / batchSize),
      message: `Index sémantique : ${slug} (0 / ${verses.length} versets)…`,
    });

    const allEmbeddings = [];
    let dimensions = 0;
    const totalBatches = Math.ceil(verses.length / batchSize);

    for (let i = 0; i < verses.length; i += batchSize) {
      const batchNum = Math.floor(i / batchSize) + 1;
      const batch = verses.slice(i, i + batchSize);
      const inputs = batch.map(verseInput);

      onProgress?.({
        phase: "building",
        slug,
        current: s + 1,
        total: slugs.length,
        verseCount: verses.length,
        batch: batchNum,
        totalBatches,
        processedVerses: Math.min(i + batch.length, verses.length),
        message: `${slug} : ${Math.min(i + batch.length, verses.length)} / ${verses.length} versets…`,
      });

      const embeddings =
        provider === "local"
          ? await embedBatchLocal(inputs)
          : await embedBatchOpenAI(openai, inputs);

      for (const emb of embeddings) {
        if (!dimensions) dimensions = emb.length;
        allEmbeddings.push(emb);
      }
    }

    const flat = new Float32Array(allEmbeddings.length * dimensions);
    allEmbeddings.forEach((emb, idx) => {
      flat.set(emb, idx * dimensions);
    });

    const meta = {
      slug,
      provider,
      model: modelLabel,
      dimensions,
      count: verses.length,
      verseKeys: verses.map(verseKey),
      builtAt: new Date().toISOString(),
    };

    const binPath = path.join(BIBLES_DIR, `${slug}${suffix}.embeddings.bin`);
    const metaPath = path.join(BIBLES_DIR, `${slug}${suffix}.embeddings.meta.json`);

    fs.writeFileSync(binPath, Buffer.from(flat.buffer));
    fs.writeFileSync(metaPath, JSON.stringify(meta));

    const mb = Number((fs.statSync(binPath).size / 1024 / 1024).toFixed(1));
    built.push({ slug, provider, model: modelLabel, verseCount: verses.length, sizeMb: mb });
  }

  return { built, provider, model: modelLabel };
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const slugArgs = args.filter((a) => !a.startsWith("--"));
  let provider;
  if (flags.has("--local")) provider = "local";
  if (flags.has("--openai")) provider = "openai";

  try {
    await runBuildEmbeddings({ slugs: slugArgs, provider });
    console.log("\nRedémarre le backend pour charger l'index.");
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isDirectExecution()) {
  dotenv.config({ path: path.join(__dirname, "..", ".env") });
  main();
}
