import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOK_FR_PATH = path.join(__dirname, "..", "data", "book-names-fr.json");

let bookFr = null;

function loadBookFr() {
  if (!bookFr) {
    bookFr = JSON.parse(fs.readFileSync(BOOK_FR_PATH, "utf-8"));
  }
  return bookFr;
}

export function normalizeBookDisplay(name) {
  const s = String(name || "").trim();
  const numbered = s.match(/^(\d+)\s+(.+)$/i);
  if (numbered) {
    const rest =
      numbered[2].charAt(0).toUpperCase() + numbered[2].slice(1).toLowerCase();
    return `${numbered[1]} ${rest}`;
  }
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Convertit clés Baraka / scrollmapper (ex. I chronicles) vers noms FR affichés. */
export function bookToFrench(name) {
  const map = loadBookFr();
  let raw = String(name || "").trim();
  if (!raw) return raw;

  if (map[raw]) return map[raw];

  // Baraka: "1Chronicles" → "1 Chronicles"
  raw = raw.replace(/^(\d+)([A-Za-z])/, "$1 $2");

  // Romains mal formés: "I chronicles", "Ii corinthians"
  const roman = raw.match(/^(i{1,3}|ii|iii|iv)\s+(.+)$/i);
  if (roman) {
    const r = roman[1].toLowerCase();
    const num =
      r === "i" ? "1" : r === "ii" ? "2" : r === "iii" ? "3" : r === "iv" ? "4" : r;
    const rest =
      roman[2].charAt(0).toUpperCase() + roman[2].slice(1).toLowerCase();
    raw = `${num} ${rest}`;
  }

  const titleCase = raw
    .split(/\s+/)
    .map((w, i) =>
      i === 0 && /^\d+$/.test(w)
        ? w
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    )
    .join(" ");

  if (map[titleCase]) return map[titleCase];
  if (map[raw]) return map[raw];

  return normalizeBookDisplay(name);
}

export function fixVerseBookNames(verses) {
  let changed = 0;
  for (const v of verses) {
    const next = bookToFrench(v.book);
    if (next && next !== v.book) {
      v.book = next;
      changed += 1;
    }
  }
  return changed;
}
