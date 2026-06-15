#!/usr/bin/env node
/**
 * Corrige les noms de livres (ex. I chronicles → 1 Chroniques) dans les JSON bible.
 * Usage: npm run fix-book-names [-- louis-segond darby]
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { bookToFrench, fixVerseBookNames } from "../lib/book-names.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIBLES_DIR = path.join(__dirname, "..", "data", "bibles");

function main() {
  const slugs = process.argv.slice(2).length
    ? process.argv.slice(2)
    : fs
        .readdirSync(BIBLES_DIR)
        .filter((f) => f.endsWith(".json") && f !== "index.json")
        .map((f) => f.replace(/\.json$/, ""));

  for (const slug of slugs) {
    const filePath = path.join(BIBLES_DIR, `${slug}.json`);
    if (!fs.existsSync(filePath)) {
      console.warn(`Ignoré: ${filePath}`);
      continue;
    }
    const payload = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const verses = payload.verses || payload;
    if (!verses.length) {
      console.log(`○ ${slug}: vide`);
      continue;
    }
    const before = new Set(verses.map((v) => v.book));
    const changed = fixVerseBookNames(verses);
    const after = new Set(verses.map((v) => v.book));
    fs.writeFileSync(
      filePath,
      JSON.stringify({ ...payload, verses }, null, 0)
    );
    console.log(
      `✅ ${slug}: ${changed} versets corrigés, ${before.size} → ${after.size} noms de livres`
    );
  }
}

main();
