#!/usr/bin/env node
/**
 * Prépare et construit un installeur VersePilot Live pour livraison client.
 *
 * Usage :
 *   npm run release          # macOS (dmg) par défaut sur Mac, win sur Windows
 *   npm run release:mac      # dmg macOS (sans signature Apple)
 *   npm run release:win      # installeur NSIS Windows
 *   npm run release:dir      # dossier .app / win-unpacked (test rapide)
 *
 * Options :
 *   --skip-install   ne pas relancer npm install
 *   --skip-bibles    ne pas vérifier les fichiers bible JSON
 *   --with-bibles    importe les bibles avant le build (long)
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const BACKEND_DATA = path.join(ROOT, "backend", "data");
const BIBLES_DIR = path.join(BACKEND_DATA, "bibles");

const args = process.argv.slice(2);
const skipInstall = args.includes("--skip-install");
const skipBibles = args.includes("--skip-bibles");
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
    const louisSegond = path.join(BIBLES_DIR, "louis-segond.json");
    if (!fs.existsSync(louisSegond)) {
      console.error(
        "✗ Louis Segond manquant (backend/data/bibles/louis-segond.json).\n" +
          "   Lance : npm run bootstrap:full\n" +
          "   ou    : npm run release -- --with-bibles"
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

  console.log("\n📋 Livraison client :");
  console.log("   1. Transférer le fichier d'installation (dmg / exe)");
  console.log("   2. Joindre delivery/docs/GUIDE-INSTALLATION.md");
  console.log("   3. Joindre delivery/docs/GUIDE-PROPRESENTER.md");
  console.log("   (Les guides sont aussi copiés dans l'app : Resources/docs/)");
  console.log("\n⚠ macOS sans signature : clic droit → Ouvrir la première fois.");
}

console.log("═══════════════════════════════════════════");
console.log("  VersePilot Live — build de livraison");
console.log("═══════════════════════════════════════════\n");

checkNode();
verifyReleaseData();

if (withBibles) {
  run("import-bibles", "npm", ["run", "import-bibles", "--prefix", "backend"]);
}

if (!skipInstall) {
  run("npm install (racine)", "npm", ["install"], ROOT);
  run("npm install (backend)", "npm", ["install"], path.join(ROOT, "backend"));
  run("npm install (frontend)", "npm", ["install"], path.join(ROOT, "frontend"));
}

run("build frontend", "npm", ["run", "build", "--prefix", "frontend"]);
run("electron-builder", "npx", electronBuilderArgs(), ROOT);

printArtifacts();
console.log("\n✓ Build terminé.\n");
