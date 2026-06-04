#!/usr/bin/env node
/**
 * Construit l'index OpenAI embeddings pour une bible (1 fichier .bin + .meta.json).
 *
 * Usage:
 *   cd backend && npm run build-embeddings
 *   npm run build-embeddings -- louis-segond darby
 *
 * Coût indicatif: ~0,03 $ pour 31k versets (text-embedding-3-small).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import OpenAI from "openai";
import { verseKey } from "../lib/verse-embeddings.js";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIBLES_DIR = path.join(__dirname, "..", "data", "bibles");
const MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const BATCH_SIZE = Number(process.env.EMBEDDING_BATCH_SIZE || 256);

async function main() {
  const slugs = process.argv.slice(2).length
    ? process.argv.slice(2)
    : [process.env.BIBLE_VERSION || "louis-segond"];

  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY manquant dans backend/.env");
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

    console.log(`\n→ ${slug} — ${verses.length} versets, modèle ${MODEL}`);

    const allEmbeddings = [];
    let dimensions = 0;

    for (let i = 0; i < verses.length; i += BATCH_SIZE) {
      const batch = verses.slice(i, i + BATCH_SIZE);
      const inputs = batch.map((v) => {
        const ref = `${v.book} ${v.chapter}:${v.verse}`;
        return `${ref}. ${v.text}`.slice(0, 2000);
      });

      process.stdout.write(
        `  batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(verses.length / BATCH_SIZE)}... `
      );

      const res = await openai.embeddings.create({ model: MODEL, input: inputs });
      const sorted = [...res.data].sort((a, b) => a.index - b.index);

      for (const row of sorted) {
        if (!dimensions) dimensions = row.embedding.length;
        allEmbeddings.push(row.embedding);
      }

      console.log("ok");
    }

    const flat = new Float32Array(allEmbeddings.length * dimensions);
    allEmbeddings.forEach((emb, idx) => {
      flat.set(emb, idx * dimensions);
    });

    const meta = {
      slug,
      model: MODEL,
      dimensions,
      count: verses.length,
      verseKeys: verses.map(verseKey),
      builtAt: new Date().toISOString(),
    };

    const binPath = path.join(BIBLES_DIR, `${slug}.embeddings.bin`);
    const metaPath = path.join(BIBLES_DIR, `${slug}.embeddings.meta.json`);

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
