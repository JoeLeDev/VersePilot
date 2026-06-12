#!/usr/bin/env node
/**
 * Construit l'index d'embeddings pour une bible (1 fichier .bin + .meta.json).
 *
 * Deux fournisseurs :
 *   - openai (défaut) : text-embedding-3-small via l'API OpenAI.
 *       npm run build-embeddings              # bible active
 *       npm run build-embeddings -- darby     # versions précises
 *   - local : serveur d'embeddings local (sentence-transformers, hors-ligne).
 *       npm run build-embeddings:local
 *       npm run build-embeddings:local -- darby
 *
 * Le fournisseur peut être forcé par --local / --openai ou EMBEDDINGS_PROVIDER.
 * Les index locaux sont écrits dans `${slug}.local.embeddings.*` pour cohabiter
 * avec les index OpenAI (`${slug}.embeddings.*`).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import OpenAI from "openai";
import { verseKey, embeddingVariantSuffix } from "../lib/verse-embeddings.js";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIBLES_DIR = path.join(__dirname, "..", "data", "bibles");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const slugArgs = args.filter((a) => !a.startsWith("--"));

let provider = (process.env.EMBEDDINGS_PROVIDER || "openai").toLowerCase();
if (flags.has("--local")) provider = "local";
if (flags.has("--openai")) provider = "openai";

const OPENAI_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const LOCAL_EMBED_URL = (process.env.LOCAL_EMBED_URL || "http://127.0.0.1:8003").replace(/\/$/, "");
const LOCAL_EMBED_MODEL = process.env.LOCAL_EMBED_MODEL || "intfloat/multilingual-e5-small";
const BATCH_SIZE = Number(process.env.EMBEDDING_BATCH_SIZE || (provider === "local" ? 64 : 256));

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

async function main() {
  const slugs = slugArgs.length ? slugArgs : [process.env.BIBLE_VERSION || "louis-segond"];

  let openai = null;
  if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY manquant dans backend/.env");
      process.exit(1);
    }
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } else {
    // Vérifie que le serveur local répond et préchauffe le modèle.
    try {
      await fetch(`${LOCAL_EMBED_URL}/warmup`, { method: "POST" });
    } catch {
      console.error(
        `Serveur d'embeddings local injoignable sur ${LOCAL_EMBED_URL}.\n` +
          "Lance-le d'abord : npm run embed-server"
      );
      process.exit(1);
    }
  }

  const modelLabel = provider === "local" ? LOCAL_EMBED_MODEL : OPENAI_MODEL;
  const suffix = embeddingVariantSuffix(provider);

  for (const slug of slugs) {
    const biblePath = path.join(BIBLES_DIR, `${slug}.json`);
    if (!fs.existsSync(biblePath)) {
      console.error(`Fichier introuvable: ${biblePath}`);
      continue;
    }

    const payload = JSON.parse(fs.readFileSync(biblePath, "utf-8"));
    const verses = payload.verses || payload;
    if (!verses.length) {
      console.error(`${slug}: aucun verset`);
      continue;
    }

    console.log(`\n→ ${slug} — ${verses.length} versets, [${provider}] ${modelLabel}`);

    const allEmbeddings = [];
    let dimensions = 0;
    const totalBatches = Math.ceil(verses.length / BATCH_SIZE);

    for (let i = 0; i < verses.length; i += BATCH_SIZE) {
      const batch = verses.slice(i, i + BATCH_SIZE);
      const inputs = batch.map(verseInput);
      process.stdout.write(`  batch ${Math.floor(i / BATCH_SIZE) + 1}/${totalBatches}... `);

      const embeddings =
        provider === "local"
          ? await embedBatchLocal(inputs)
          : await embedBatchOpenAI(openai, inputs);

      for (const emb of embeddings) {
        if (!dimensions) dimensions = emb.length;
        allEmbeddings.push(emb);
      }
      console.log("ok");
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

    const mb = (fs.statSync(binPath).size / 1024 / 1024).toFixed(1);
    console.log(`✅ ${slug}: ${binPath} (${mb} Mo, ${dimensions}D × ${verses.length})`);
  }

  console.log("\nRedémarre le backend pour charger l'index.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
