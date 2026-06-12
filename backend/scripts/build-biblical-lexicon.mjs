#!/usr/bin/env node
/**
 * Génère backend/data/biblical-lexicon.json à partir du seed + variantes STT.
 * Usage: node scripts/build-biblical-lexicon.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "data");
const SEED_PATH = path.join(DATA, "biblical-lexicon-seed.json");
const CANON_PATH = path.join(DATA, "bible-canon-fr.json");
const BOOK_FR_PATH = path.join(DATA, "book-names-fr.json");
const OUT_PATH = path.join(DATA, "biblical-lexicon.json");

function normalizeKey(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[''`]/g, "'")
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripAccents(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

const EXTRA_PERSONNAGES = [
  "Abraham", "Isaac", "Jacob", "Joseph", "Moïse", "Aaron", "Josué", "Caleb",
  "Gédéon", "Samson", "Samuel", "Saül", "David", "Salomon", "Élie", "Nathanaël",
  "André", "Pierre", "Jean-Baptiste", "Paul", "Apollos", "Étienne", "Philippe",
  "Thomas", "Matthieu", "Marc", "Luc", "Judas", "Pilate", "Hérode", "Hérodiade",
  "Caïphe", "Anne", "Caïn", "Abel", "Noé", "Enoch", "Loth", "Ruth", "Boaz",
  "Naomi", "Esther", "Mardochée", "Job", "Jonas", "Daniel", "Hanania", "Mischaël",
  "Azaria", "Susanne", "Tobie", "Judith", "Esdras", "Néhémie", "Zacharie père de Jean",
  "Élisabeth", "Siméon", "Anne prophétesse", "Magdeleine", "Cléopas", "Emmaüs",
  "Abimélec", "Abner", "Adonija", "Agabus", "Agrippa", "Ahasverus", "Amon",
  "Amos", "Amnon", "Anathoth", "Aquila", "Archélaüs", "Arphaxad", "Asa",
  "Asaph", "Aser", "Athalie", "Azor", "Balaam", "Balak", "Barak", "Bath-Schéba",
  "Benjamin", "Booz", "César", "Débora", "Darius", "Delila", "Édom", "Énoch",
  "Éphraïm", "Ésaü", "Étam", "Ézéchiel prophète", "Goliath", "Habacuc prophète",
  "Hagar", "Haggai", "Haman", "Héman", "Hophni", "Ismaël", "Japhet", "Jéricho",
  "Jérémie", "Jéthro", "Joab", "Joël", "Jonathan", "Josaphat", "Josias", "Juda",
  "Laban", "Léa", "Lévi", "Lot", "Madian", "Manassé", "Mardochée", "Mélchisédek",
  "Michée", "Miriam", "Nabal", "Naboth", "Nahum", "Nathanaël", "Néhémie",
  "Nikanor", "Nimrod", "Obéd", "Onésime", "Osée", "Ozias", "Pharaon", "Potiphar",
  "Rahab", "Rahel", "Rébecca", "Ruben", "Salomé", "Sara", "Séphora", "Seth",
  "Siméon fils de Jacob", "Tamar", "Urie", "Zacharie prophète", "Zébulon",
  "Zéphania", "Zorobabel", "Abigail", "Abinadab", "Abisag", "Abner", "Achab",
  "Achaz", "Adonija", "Agabus", "Agar", "Ahaschérès", "Ahitophel", "Amazia",
  "Amos prophète", "Ananias et Saphira", "Apollonie", "Arioch", "Asenath",
  "Balthazar", "Baruc", "Benaïa", "Bersabée", "Cyrus", "Démas", "Éli", "Éliab",
  "Éliézer de Damas", "Ésaïe", "Ézéchias roi", "Gédéon", "Gog", "Magog",
  "Hophni et Phinées", "Ismaël fils d'Abraham", "Jéhu", "Jérémie prophète",
  "Jésus-Christ", "Jokébed", "Jonas prophète", "Josias roi", "Juda fils de Jacob",
  "Lazare de Béthanie", "Lévi Matthieu", "Lot neveu d'Abraham", "Luc évangéliste",
  "Marc évangéliste", "Matthieu évangéliste", "Michée prophète", "Moïse",
  "Nathanaël", "Nicolas", "Noé", "Onésime", "Osée prophète", "Paul apôtre",
  "Pierre apôtre", "Pharaon d'Égypte", "Phinées", "Pilate", "Rahab prostituée",
  "Rébecca", "Ruth Moabite", "Salomon roi", "Samson juge", "Samuel prophète",
  "Saül roi", "Siméon juste", "Thomas apôtre", "Timothée disciple", "Tite",
  "Uzziah", "Zacharie père de Jean-Baptiste", "Zorobabel gouverneur",
];

const EXTRA_LIEUX = [
  "Éden", "Ararat", "Ur", "Haran", "Canaan", "Égypte", "Goshen", "Madian",
  "Sinaï", "Horeb", "Kadesh", "Gilgal", "Shilo", "Gabaon", "Hébron", "Beer-Schéba",
  "Sichem", "Bethel", "Gilboa", "Carmel", "Jizreel", "Ramoth", "Dan", "Beersheba",
  "Moab", "Ammon", "Édom", "Assyrie", "Perse", "Médie", "Grèce", "Rome",
  "Corinthe", "Athènes", "Crète", "Chypre", "Malte", "Galilée", "Judée", "Samarie",
  "Golgotha", "Siloam", "Emmaüs", "Césarée", "Joppé", "Lystre", "Derbe", "Iconium",
  "Milet", "Troas", "Smyrne", "Éphèse", "Rhodes", "Malte", "Sicile", "Italie",
  "Mont Morija", "Mont Carmel", "Vallée du Cédron", "Vallée de Josaphat",
  "Mer Morte", "Jourdain", "Nil", "Euphrate", "Tigre", "Kishon", "Liban",
  "Mont Hermon", "Mont Thabor", "Mont Nébo", "Mont Garizim", "Mont Ébal",
];

const BOOK_ORAL_ALIASES = {
  Genèse: ["genese", "genèse", "gen", "genesis"],
  Exode: ["exode", "ex", "exodus"],
  Lévitique: ["levitique", "lévitique", "lev", "leviticus"],
  Nombres: ["nombres", "nom", "numbers"],
  Deutéronome: ["deuteronome", "deuteronomie", "deut", "deuteronomy"],
  Josué: ["josue", "josué", "joshua"],
  Juges: ["juges", "judges"],
  Ruth: ["ruth"],
  "1 Samuel": ["1 samuel", "premier samuel", "1 sam", "1samuel"],
  "2 Samuel": ["2 samuel", "deuxieme samuel", "2 sam", "2samuel"],
  "1 Rois": ["1 rois", "premier rois", "1 kings"],
  "2 Rois": ["2 rois", "deuxieme rois", "2 kings"],
  "1 Chroniques": ["1 chroniques", "premier chroniques", "1 chron"],
  "2 Chroniques": ["2 chroniques", "deuxieme chroniques", "2 chron"],
  Esdras: ["esdras", "ezra"],
  Néhémie: ["nehemie", "néhémie", "nehemiah"],
  Esther: ["esther"],
  Job: ["job"],
  Psaumes: ["psaumes", "psaume", "ps", "psalm", "psalms"],
  Proverbes: ["proverbes", "proverbe", "prov"],
  Ecclésiaste: ["ecclesiaste", "ecclésiaste", "ecclesiastes", "qohéleth"],
  "Cantique des Cantiques": ["cantique", "cantique des cantiques", "song of solomon"],
  Ésaïe: ["esaie", "ésaïe", "isaiah", "isaïe"],
  Jérémie: ["jeremie", "jérémie", "jeremiah"],
  Lamentations: ["lamentations", "threnes"],
  Ézéchiel: ["ezechiel", "ézéchiel", "ezekiel"],
  Daniel: ["daniel", "dan"],
  Osée: ["osee", "osée", "hosea"],
  Joël: ["joel", "joël"],
  Amos: ["amos"],
  Abdias: ["abdias", "obadiah"],
  Jonas: ["jonas", "jonah"],
  Michée: ["michee", "michée", "micah"],
  Nahum: ["nahum"],
  Habacuc: ["habacuc", "habakuk"],
  Sophonie: ["sophonie", "zephaniah"],
  Aggée: ["aggee", "aggée", "haggai"],
  Zacharie: ["zacharie", "zechariah"],
  Malachie: ["malachie", "malachi"],
  Matthieu: ["matthieu", "matieu", "matheu", "matthew", "mt"],
  Marc: ["marc", "mark", "mc"],
  Luc: ["luc", "luke", "lc"],
  Jean: ["jean", "john", "jn", "jan", "johan"],
  Actes: ["actes", "acts", "ac"],
  Romains: ["romains", "romain", "romans", "rm"],
  "1 Corinthiens": ["1 corinthiens", "premier corinthiens", "1 co", "corinthiens"],
  "2 Corinthiens": ["2 corinthiens", "deuxieme corinthiens", "2 co"],
  Galates: ["galates", "galatians", "ga"],
  Éphésiens: ["ephesiens", "éphésiens", "ephesians", "ep", "eph"],
  Philippiens: ["philippiens", "philippians", "phil"],
  Colossiens: ["colossiens", "colossians", "col"],
  "1 Thessaloniciens": ["1 thessaloniciens", "1 thess", "premier thessaloniciens"],
  "2 Thessaloniciens": ["2 thessaloniciens", "2 thess", "deuxieme thessaloniciens"],
  "1 Timothée": ["1 timothee", "1 timothée", "premier timothée"],
  "2 Timothée": ["2 timothee", "2 timothée", "deuxieme timothée"],
  Tite: ["tite", "titus"],
  Philémon: ["philemon", "philémon"],
  Hébreux: ["hebreux", "hébreux", "hebrews", "he"],
  Jacques: ["jacques", "james", "jg"],
  "1 Pierre": ["1 pierre", "premier pierre", "1 pet"],
  "2 Pierre": ["2 pierre", "deuxieme pierre", "2 pet"],
  "1 Jean": ["1 jean", "premier jean", "1 jn"],
  "2 Jean": ["2 jean", "deuxieme jean"],
  "3 Jean": ["3 jean", "troisieme jean"],
  Jude: ["jude"],
  Apocalypse: ["apocalypse", "revelation", "ap", "apoc", "apocalyps"],
};

function oralSplitVariants(phrase) {
  const out = new Set();
  const parts = String(phrase || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  for (const part of parts) {
    const w = normalizeKey(part);
    if (w.length < 8) continue;
    const mid = Math.floor(w.length / 2);
    out.add(`${w.slice(0, mid)} ${w.slice(mid)}`);
    if (w.length >= 10) {
      out.add(`${w.slice(0, 3)} ${w.slice(3)}`);
      out.add(`${w.slice(0, 4)} ${w.slice(4)}`);
    }
  }

  if (parts.length === 1) {
    const w = normalizeKey(parts[0]);
    if (w.length >= 10) {
      for (let i = 4; i <= w.length - 4; i += 2) {
        out.add(`${w.slice(0, i)} ${w.slice(i)}`);
      }
    }
  }

  return [...out];
}

function phoneticVariants(phrase) {
  const out = new Set();
  const base = normalizeKey(phrase);
  if (!base || base.length < 2) return [];

  out.add(base);
  out.add(stripAccents(phrase).toLowerCase().trim());
  for (const split of oralSplitVariants(phrase)) out.add(normalizeKey(split));

  const transforms = [
    (s) => s.replace(/ph/g, "f"),
    (s) => s.replace(/th/g, "t"),
    (s) => s.replace(/ch/g, "sh"),
    (s) => s.replace(/ç/g, "c"),
    (s) => s.replace(/gn/g, "n"),
    (s) => s.replace(/ae/g, "e"),
    (s) => s.replace(/oe/g, "e"),
    (s) => s.replace(/ou/g, "u"),
    (s) => s.replace(/eau/g, "o"),
    (s) => s.replace(/au/g, "o"),
    (s) => s.replace(/ei/g, "e"),
    (s) => s.replace(/sch/g, "sh"),
    (s) => s.replace(/ss/g, "s"),
    (s) => s.replace(/ll/g, "l"),
    (s) => s.replace(/nn/g, "n"),
    (s) => s.replace(/mm/g, "m"),
    (s) => s.replace(/tt/g, "t"),
    (s) => s.replace(/\s+de\s+/g, " "),
    (s) => s.replace(/\s+des\s+/g, " "),
    (s) => s.replace(/\s+du\s+/g, " "),
    (s) => s.replace(/\s+d\s+/g, " "),
    (s) => s.replace(/\s+l\s+/g, " "),
    (s) => s.replace(/['']/g, ""),
    (s) => s.replace(/\s+/g, ""),
    (s) => s.replace(/(.)\1{2,}/g, "$1$1"),
    (s) => s.replace(/h/g, ""),
    (s) => s.replace(/x/g, "ks"),
    (s) => s.replace(/qu/g, "k"),
    (s) => s.replace(/y/g, "i"),
  ];

  const queue = [base];
  for (const s of queue) {
    for (const fn of transforms) {
      const v = normalizeKey(fn(s));
      if (v && v.length >= 2 && !out.has(v)) {
        out.add(v);
        if (queue.length < 80) queue.push(v);
      }
    }
  }

  const expanded = new Set(out);
  for (const v of [...out]) {
    for (const split of oralSplitVariants(v)) expanded.add(normalizeKey(split));
  }

  return [...expanded].filter((v) => v !== base);
}

function mergeEntry(map, entry) {
  const canonical = String(entry.canonical || "").trim();
  if (!canonical) return;

  const key = normalizeKey(canonical);
  if (!map.has(key)) {
    map.set(key, {
      canonical,
      aliases: new Set(),
      type: entry.type || "terme",
      references: [...(entry.references || [])],
    });
  }

  const row = map.get(key);
  if (entry.type && !row.type) row.type = entry.type;
  for (const ref of entry.references || []) {
    if (!row.references.includes(ref)) row.references.push(ref);
  }

  const canonicalKey = normalizeKey(canonical);
  const MAX_ALIASES = 32;

  const addAlias = (aliasStr) => {
    const aliasKey = normalizeKey(aliasStr);
    if (!aliasKey || aliasKey === canonicalKey || aliasKey.length < 2) return;
    if (isUnsafeAlias(aliasKey, canonicalKey)) return;
    row.aliases.add(String(aliasStr).trim());
  };

  for (const alias of entry.aliases || []) addAlias(alias);

  const generated = new Set();
  for (const src of [canonical, ...(entry.aliases || [])]) {
    for (const v of phoneticVariants(src)) generated.add(v);
  }

  const rankedGenerated = [...generated]
    .map((a) => String(a).trim())
    .filter(Boolean)
    .sort((a, b) => normalizeKey(b).length - normalizeKey(a).length);

  for (const aliasStr of rankedGenerated) {
    if (row.aliases.size >= MAX_ALIASES) break;
    addAlias(aliasStr);
  }
}

function isUnsafeAlias(aliasKey, canonicalKey) {
  const canonicalWords = canonicalKey.split(" ").filter(Boolean);
  if (canonicalWords.length > 1 && canonicalWords.includes(aliasKey)) return true;
  if (aliasKey.length < 4 && canonicalKey.includes(aliasKey)) return true;
  return false;
}

function main() {
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, "utf-8"));
  const canon = JSON.parse(fs.readFileSync(CANON_PATH, "utf-8"));
  const bookFr = JSON.parse(fs.readFileSync(BOOK_FR_PATH, "utf-8"));

  const map = new Map();

  for (const entry of seed) mergeEntry(map, entry);

  for (const book of canon) {
    mergeEntry(map, {
      canonical: book,
      aliases: BOOK_ORAL_ALIASES[book] || phoneticVariants(book),
      type: "livre",
      references: [book],
    });
  }

  for (const fr of Object.values(bookFr)) {
    if (!canon.includes(fr)) {
      mergeEntry(map, {
        canonical: fr,
        aliases: phoneticVariants(fr),
        type: "livre",
        references: [fr],
      });
    }
  }

  for (const name of EXTRA_PERSONNAGES) {
    mergeEntry(map, {
      canonical: name,
      aliases: phoneticVariants(name),
      type: "personnage",
      references: [],
    });
  }

  for (const place of EXTRA_LIEUX) {
    mergeEntry(map, {
      canonical: place,
      aliases: phoneticVariants(place),
      type: "lieu",
      references: [],
    });
  }

  const entries = [...map.values()]
    .map((row) => ({
      canonical: row.canonical,
      aliases: [...row.aliases].sort((a, b) => b.length - a.length),
      type: row.type,
      references: row.references,
    }))
    .sort((a, b) => a.canonical.localeCompare(b.canonical, "fr"));

  let aliasCount = 0;
  for (const e of entries) aliasCount += e.aliases.length;

  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entryCount: entries.length,
    aliasCount,
    entries,
  };

  fs.writeFileSync(OUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf-8");
  console.log(
    `✓ Lexique biblique : ${entries.length} entrées, ${aliasCount} alias → ${OUT_PATH}`
  );
}

main();
