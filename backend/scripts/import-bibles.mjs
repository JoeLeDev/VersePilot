#!/usr/bin/env node
/**
 * Un fichier JSON par version biblique (sans mélange).
 *
 * Usage:
 *   npm run import-bibles              # catalogue prioritaire (FR culte)
 *   npm run import-bibles louis-segond darby
 *   npm run import-bibles --legacy     # anciennes versions scrollmapper (catalogue étendu)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { bookToFrench, normalizeBookDisplay } from "../lib/book-names.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data", "bibles");
const CATALOG_PATH = path.join(__dirname, "versions-catalog.json");
const LEGACY_CATALOG_PATH = path.join(__dirname, "versions-catalog-legacy.json");
const CANON_FR_PATH = path.join(ROOT, "data", "bible-canon-fr.json");

const SCROLLMAPPER_BASE =
  "https://raw.githubusercontent.com/scrollmapper/bible_databases/master/formats/json";
const HELLOAO_BASE = "https://bible.helloao.org/api";
const BARAKA_LSG_URL =
  "https://github.com/baraka-bilali/obs_bible_free_version/raw/main/bible-versions/versions/fr/LSG.json";

const canonFr = JSON.parse(fs.readFileSync(CANON_FR_PATH, "utf-8"));

function cleanVerseText(text) {
  return String(text || "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function writePayload(outPath, meta, verses) {
  const payload = {
    meta: {
      ...meta,
      verseCount: verses.length,
      importedAt: new Date().toISOString(),
    },
    verses,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload));
  const mb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  return { mb, count: verses.length };
}

function convertScrollmapper(raw, meta) {
  const verses = [];
  for (const book of raw.books || []) {
    const bookName = bookToFrench(book.name);
    for (const chapter of book.chapters || []) {
      for (const v of chapter.verses || []) {
        verses.push({
          book: bookName,
          chapter: chapter.chapter,
          verse: v.verse,
          version: meta.code,
          text: cleanVerseText(v.text),
        });
      }
    }
  }
  return verses;
}

function convertHelloao(raw, meta) {
  const verses = [];
  for (const book of raw.books || []) {
    const bookName = normalizeBookDisplay(book.commonName || book.name);
    for (const chWrapper of book.chapters || []) {
      const ch = chWrapper.chapter;
      for (const item of ch.content || []) {
        if (item.type !== "verse") continue;
        const text = cleanVerseText(
          (item.content || []).map((c) => (typeof c === "string" ? c : "")).join(" ")
        );
        if (!text) continue;
        verses.push({
          book: bookName,
          chapter: ch.number,
          verse: item.number,
          version: meta.code,
          text,
        });
      }
    }
  }
  return verses;
}

function convertBarakaLsg(raw, meta) {
  const verses = [];
  for (const [bookEn, chapters] of Object.entries(raw.books || {})) {
    const bookName = bookToFrench(bookEn);
    for (const [ch, versesMap] of Object.entries(chapters)) {
      for (const [v, text] of Object.entries(versesMap)) {
        verses.push({
          book: bookName,
          chapter: Number(ch),
          verse: Number(v),
          version: meta.code,
          text: cleanVerseText(text),
        });
      }
    }
  }
  return verses;
}

function convertDataGouvFrc97(raw, meta) {
  const verses = [];
  let bookIndex = 0;
  for (const testament of raw.Testaments || []) {
    for (const book of testament.Books || []) {
      const bookName = canonFr[bookIndex] || `Livre ${bookIndex + 1}`;
      bookIndex += 1;
      for (const chapter of book.Chapters || []) {
        let verseNum = 1;
        for (const v of chapter.Verses || []) {
          const id = v.ID ?? v.Id ?? verseNum;
          const text = cleanVerseText(v.Text ?? v.text ?? "");
          if (text) {
            verses.push({
              book: bookName,
              chapter: chapter.ID ?? chapter.Id ?? 1,
              verse: Number(id) || verseNum,
              version: meta.code,
              text,
            });
          }
          verseNum += 1;
        }
      }
    }
  }
  return verses;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} pour ${url}`);
  return res.json();
}

async function importUnavailable(meta) {
  const outPath = path.join(DATA_DIR, `${meta.slug}.json`);
  writePayload(outPath, {
    slug: meta.slug,
    code: meta.code,
    name: meta.name,
    language: meta.lang,
    available: false,
    unavailableReason: meta.unavailableReason,
    source: "unavailable",
  }, []);
  console.log(`○ ${meta.slug} — non disponible (fichier placeholder)`);
  return {
    ...meta,
    file: `${meta.slug}.json`,
    verseCount: 0,
    available: false,
  };
}

async function importVersion(meta) {
  if (meta.source === "unavailable") {
    return importUnavailable(meta);
  }

  const outPath = path.join(DATA_DIR, `${meta.slug}.json`);
  process.stdout.write(`→ ${meta.slug} (${meta.name})... `);

  let verses = [];
  let sourceLabel = meta.source;

  if (meta.source === "helloao") {
    const raw = await fetchJson(`${HELLOAO_BASE}/${meta.helloaoId}/complete.json`);
    verses = convertHelloao(raw, meta);
  } else if (meta.source === "baraka-lsg") {
    const raw = await fetchJson(BARAKA_LSG_URL);
    verses = convertBarakaLsg(raw, meta);
  } else if (meta.source === "datagouv-frc97") {
    const raw = await fetchJson(meta.datagouvUrl);
    verses = convertDataGouvFrc97(raw, meta);
  } else if (meta.source === "scrollmapper") {
    const raw = await fetchJson(`${SCROLLMAPPER_BASE}/${meta.scrollmapper}.json`);
    verses = convertScrollmapper(raw, meta);
  } else {
    throw new Error(`Source inconnue: ${meta.source}`);
  }

  const { mb, count } = writePayload(
    outPath,
    {
      slug: meta.slug,
      code: meta.code,
      name: meta.name,
      language: meta.lang,
      available: true,
      source: sourceLabel,
    },
    verses
  );

  console.log(`${count} versets (${mb} Mo)`);
  return {
    ...meta,
    file: `${meta.slug}.json`,
    verseCount: count,
    available: true,
    sizeMb: Number(mb),
  };
}

function writeIndex(imported) {
  const index = {
    updatedAt: new Date().toISOString(),
    note: "Un fichier JSON par version — ne pas fusionner les versions.",
    versions: imported
      .map((v) => ({
        slug: v.slug,
        code: v.code,
        name: v.name,
        language: v.lang,
        file: v.file,
        verseCount: v.verseCount ?? 0,
        available: v.available !== false,
        unavailableReason: v.unavailableReason || undefined,
        source: v.source,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "fr")),
  };
  fs.writeFileSync(path.join(DATA_DIR, "index.json"), JSON.stringify(index, null, 2));
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const args = process.argv.slice(2);
  const useLegacy = args.includes("--legacy");
  const slugs = args.filter((a) => !a.startsWith("--"));

  let catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf-8"));
  if (useLegacy && fs.existsSync(LEGACY_CATALOG_PATH)) {
    catalog = JSON.parse(fs.readFileSync(LEGACY_CATALOG_PATH, "utf-8"));
    console.log(`Import catalogue legacy (${catalog.length} versions)…\n`);
  } else if (slugs.length) {
    catalog = catalog.filter((v) => slugs.includes(v.slug));
    if (!catalog.length) {
      console.error("Slugs introuvables. Disponibles :");
      JSON.parse(fs.readFileSync(CATALOG_PATH, "utf-8")).forEach((v) =>
        console.error(`  - ${v.slug}`)
      );
      process.exit(1);
    }
  } else {
    console.log(`Import prioritaire (${catalog.length} entrées)…\n`);
  }

  const imported = [];
  for (const meta of catalog) {
    try {
      imported.push(await importVersion(meta));
    } catch (err) {
      console.log(`ERREUR ${meta.slug}: ${err.message}`);
      imported.push({
        ...meta,
        file: null,
        verseCount: 0,
        available: false,
        importError: err.message,
      });
    }
  }

  writeIndex(imported);
  const ok = imported.filter((v) => v.available && v.verseCount > 0).length;
  console.log(`\n✅ ${ok} bible(s) complète(s) · ${imported.length} entrée(s) dans index.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
