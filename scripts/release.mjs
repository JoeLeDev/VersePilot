#!/usr/bin/env node
/**
 * Prépare et construit un installeur VersePilot Live pour livraison client.
 *
 * Usage :
 *   npm run release          # build complet client (bibles + index sémantique inclus)
 *   npm run release:mac      # dmg macOS
 *   npm run release:win      # installeur NSIS Windows
 *   npm run release:dir      # dossier .app / win-unpacked (test rapide)
 *
 * Options :
 *   --skip-install      ne pas relancer npm install
 *   --skip-bibles       ne pas vérifier / importer les bibles
 *   --skip-embeddings   ne pas vérifier / générer l'index sémantique
 *   --with-bibles       (legacy) importe les bibles si absentes
 */
import { spawnSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const BACKEND = path.join(ROOT, "backend");
const BACKEND_DATA = path.join(BACKEND, "data");
const BIBLES_DIR = path.join(BACKEND_DATA, "bibles");
const DEFAULT_BIBLE = "louis-segond";

const args = process.argv.slice(2);
const skipInstall = args.includes("--skip-install");
const skipBibles = args.includes("--skip-bibles");
const skipEmbeddings = args.includes("--skip-embeddings");
const withBibles = args.includes("--with-bibles");
const wantMac = args.includes("--mac") || (!args.includes("--win") && process.platform === "darwin");
const wantWin = args.includes("--win") || (!args.includes("--mac") && process.platform === "win32");
const wantDir = args.includes("--dir");

function run(label, command, cmdArgs, cwd = ROOT) {
  console.log(`\n▶ ${label}\n   ${command} ${cmdArgs.join(" ")}\n`);
  const result = spawnSync(command, cmdArgs, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(`\n✗ Échec : ${label}`);
    process.exit(result.status ?? 1);
  }
}

function checkNode() {
  const major = Number.parseInt(process.version.slice(1).split(".")[0], 10);
  console.log(`Node ${process.version}`);
  if (major < 18) {
    console.error("✗ Node.js 18+ requis.");
    process.exit(1);
  }
}

function fileSizeMb(filePath) {
  const stat = fs.statSync(filePath);
  return (stat.size / (1024 * 1024)).toFixed(1);
}

function bibleJsonPath(slug = DEFAULT_BIBLE) {
  return path.join(BIBLES_DIR, `${slug}.json`);
}

function localEmbeddingBinPath(slug = DEFAULT_BIBLE) {
  return path.join(BIBLES_DIR, `${slug}.local.embeddings.bin`);
}

function localEmbeddingMetaPath(slug = DEFAULT_BIBLE) {
  return path.join(BIBLES_DIR, `${slug}.local.embeddings.meta.json`);
}

async function probeEmbedServer() {
  const url = (process.env.LOCAL_EMBED_URL || "http://127.0.0.1:8003").replace(/\/$/, "");
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}

function ensureBibles() {
  if (skipBibles) return;

  if (!fs.existsSync(bibleJsonPath())) {
    console.log("→ Bible Louis Segond absente — import automatique…");
    run("import-bibles", "npm", ["run", "import-bibles", "--prefix", "backend", "--", DEFAULT_BIBLE]);
  } else if (withBibles) {
    run("import-bibles", "npm", ["run", "import-bibles", "--prefix", "backend"]);
  }
}

async function ensureEmbeddings() {
  if (skipEmbeddings) return;

  if (
    fs.existsSync(localEmbeddingBinPath()) &&
    fs.existsSync(localEmbeddingMetaPath())
  ) {
    console.log(`✓ Index sémantique local : ${fileSizeMb(localEmbeddingBinPath())} Mo`);
    return;
  }

  console.log("→ Index sémantique absent — génération automatique (machine de build)…");

  if (!fs.existsSync(bibleJsonPath())) {
    ensureBibles();
  }

  if (!(await probeEmbedServer())) {
    console.log("→ Démarrage du serveur d'embeddings Python (machine de build uniquement)…");
    const script = path.join(BACKEND, "scripts", "embeddings", "local_embed_server.py");
    const child = spawn("python3", [script], {
      cwd: BACKEND,
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    const start = Date.now();
    while (Date.now() - start < 90000) {
      if (await probeEmbedServer()) break;
      await new Promise((r) => setTimeout(r, 800));
    }
    if (!(await probeEmbedServer())) {
      console.error(
        "✗ Serveur d'embeddings local requis pour le build.\n" +
          "   Terminal 1 : npm run embed-server --prefix backend\n" +
          "   Terminal 2 : npm run release"
      );
      process.exit(1);
    }
  }

  run("build-embeddings:local", "npm", [
    "run",
    "build-embeddings:local",
    "--prefix",
    "backend",
    "--",
    DEFAULT_BIBLE,
  ]);
}

function ensureQueryModel() {
  if (skipEmbeddings) return;

  const modelDir = path.join(BACKEND, "models", "transformers");
  const hasCache =
    fs.existsSync(modelDir) &&
    fs.readdirSync(modelDir, { recursive: true }).some((f) => String(f).includes("multilingual-e5"));

  if (hasCache) {
    console.log("✓ Modèle e5 embarqué pour les requêtes sémantiques");
    return;
  }

  console.log("→ Téléchargement du modèle e5 pour l'app client (hors-ligne)…");
  run("download-embed-model", "npm", ["run", "download-embed-model", "--prefix", "backend"], BACKEND);
}

function verifyReleaseData() {
  const required = [
    path.join(ROOT, "delivery", "default.env"),
    path.join(BACKEND_DATA, "biblical-lexicon.json"),
    path.join(BACKEND_DATA, "bible-canon-fr.json"),
    path.join(BACKEND_DATA, "book-names-fr.json"),
    path.join(BACKEND_DATA, "verses.json"),
    path.join(BIBLES_DIR, "index.json"),
  ];

  for (const file of required) {
    if (!fs.existsSync(file)) {
      console.error(`✗ Fichier requis manquant : ${path.relative(ROOT, file)}`);
      process.exit(1);
    }
  }

  if (!skipBibles) {
    const louisSegond = bibleJsonPath();
    if (!fs.existsSync(louisSegond)) {
      console.error(
        "✗ Louis Segond manquant. Relancez npm run release (import automatique)."
      );
      process.exit(1);
    }
    console.log(`✓ Bible Louis Segond : ${fileSizeMb(louisSegond)} Mo`);

    const bibleFiles = fs
      .readdirSync(BIBLES_DIR)
      .filter((f) => f.endsWith(".json") && f !== "index.json");
    const totalMb = bibleFiles.reduce((sum, f) => {
      return sum + fs.statSync(path.join(BIBLES_DIR, f)).size;
    }, 0);
    console.log(
      `✓ ${bibleFiles.length} fichier(s) bible embarqué(s) (~${(totalMb / (1024 * 1024)).toFixed(0)} Mo)`
    );
  }

  if (!skipEmbeddings) {
    if (!fs.existsSync(localEmbeddingBinPath())) {
      console.error("✗ Index sémantique local manquant après préparation.");
      process.exit(1);
    }
    console.log(`✓ Index sémantique : ${fileSizeMb(localEmbeddingBinPath())} Mo`);
  }

  const lexicon = path.join(BACKEND_DATA, "biblical-lexicon.json");
  console.log(`✓ Lexique biblique : ${fileSizeMb(lexicon)} Mo`);
}

function electronBuilderArgs() {
  const builderArgs = ["electron-builder"];
  if (wantDir) {
    if (wantMac || process.platform === "darwin") builderArgs.push("--mac", "--dir");
    else if (wantWin || process.platform === "win32") builderArgs.push("--win", "--dir");
    else builderArgs.push("--dir");
  } else if (wantMac) {
    builderArgs.push("--mac", "dmg");
  } else if (wantWin) {
    builderArgs.push("--win", "nsis");
  } else {
    builderArgs.push("--mac", "dmg");
  }
  return builderArgs;
}

function printArtifacts() {
  const distDir = path.join(ROOT, "dist");
  if (!fs.existsSync(distDir)) return;

  const artifacts = fs.readdirSync(distDir).filter((f) => {
    return (
      f.endsWith(".dmg") ||
      f.endsWith(".exe") ||
      f.endsWith(".AppImage") ||
      f.endsWith(".zip")
    );
  });

  if (artifacts.length) {
    console.log("\n📦 Artefacts générés :");
    for (const name of artifacts) {
      const full = path.join(distDir, name);
      console.log(`   ${full} (${fileSizeMb(full)} Mo)`);
    }
  }

  console.log("\n📋 Livraison client (zéro terminal) :");
  console.log("   1. Transférer le fichier d'installation (dmg / exe)");
  console.log("   2. Client : installer → ouvrir → Démarrer le live");
  console.log("   3. Bibles + index sémantique déjà inclus dans l'installeur");
  console.log("   4. Joindre delivery/docs/GUIDE-INSTALLATION.md");
  console.log("\n⚠ macOS sans signature : clic droit → Ouvrir la première fois.");
}

console.log("═══════════════════════════════════════════");
console.log("  VersePilot Live — build de livraison");
console.log("═══════════════════════════════════════════\n");

checkNode();

if (!skipInstall) {
  run("npm install (racine)", "npm", ["install"], ROOT);
  run("npm install (backend)", "npm", ["install"], BACKEND);
  run("npm install (frontend)", "npm", ["install"], path.join(ROOT, "frontend"));
}

ensureBibles();
await ensureEmbeddings();
ensureQueryModel();
verifyReleaseData();

run("build frontend", "npm", ["run", "build", "--prefix", "frontend"]);
run("electron-builder", "npx", electronBuilderArgs(), ROOT);

printArtifacts();
console.log("\n✓ Build terminé — prêt pour client non technique.\n");
