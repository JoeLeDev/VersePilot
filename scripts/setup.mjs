#!/usr/bin/env node
/**
 * Installation complète VersePilot Live sur une nouvelle machine.
 *
 * Usage (à la racine du projet) :
 *   npm run bootstrap
 *   npm run bootstrap:full    # inclut import-bibles (~15 versions, long)
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const BACKEND = path.join(ROOT, "backend");
const FRONTEND = path.join(ROOT, "frontend");

const withBibles = process.argv.includes("--with-bibles");

function run(label, command, args, cwd = ROOT) {
  console.log(`\n▶ ${label}\n   ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(`\n✗ Échec : ${label} (code ${result.status ?? 1})`);
    process.exit(result.status ?? 1);
  }
}

function npm(args, cwd = ROOT) {
  run(`npm ${args.join(" ")}`, "npm", args, cwd);
}

function checkNode() {
  const major = Number.parseInt(process.version.slice(1).split(".")[0], 10);
  console.log(`Node ${process.version} · ${process.platform} ${process.arch}`);
  if (major < 18) {
    console.error("\n✗ Node.js 18+ requis (LTS 20 ou 22 recommandé).");
    process.exit(1);
  }
  if (major >= 25) {
    console.warn(
      "\n⚠ Node.js très récent : en cas de souci avec Electron, installe la v20 LTS.\n"
    );
  }
}

function fixElectron() {
  const installScript = path.join(ROOT, "node_modules", "electron", "install.js");
  if (!fs.existsSync(installScript)) {
    console.warn("⚠ electron/install.js introuvable — npm install racine a peut-être échoué.");
    return;
  }
  run("electron install.js", process.execPath, [installScript], ROOT);

  const ver = spawnSync("npx", ["electron", "--version"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: true,
  });
  if (ver.status === 0) {
    console.log(`✓ Electron : ${ver.stdout.trim()}`);
  } else {
    console.warn(
      "⚠ Electron non vérifiable. Essaie : rm -rf node_modules/electron && npm install && npm run electron:fix"
    );
  }
}

function ensureEnv() {
  const example = path.join(BACKEND, ".env.example");
  const env = path.join(BACKEND, ".env");
  if (fs.existsSync(env)) {
    console.log("✓ backend/.env existe déjà");
    return;
  }
  if (!fs.existsSync(example)) {
    console.warn("⚠ backend/.env.example introuvable");
    return;
  }
  fs.copyFileSync(example, env);
  console.log("✓ backend/.env créé depuis .env.example — édite-le avant le culte.");
}

function ensureLexicon() {
  const lexicon = path.join(BACKEND, "data", "biblical-lexicon.json");
  if (fs.existsSync(lexicon)) {
    console.log("✓ Lexique biblique déjà présent");
    return;
  }
  npm(["run", "build-lexicon"], BACKEND);
}

function hasImportedBibles() {
  const dir = path.join(BACKEND, "data", "bibles");
  if (!fs.existsSync(dir)) return false;
  return fs
    .readdirSync(dir)
    .some((f) => f.endsWith(".json") && f !== "index.json");
}

function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  VersePilot Live — installation nouvelle machine");
  console.log("═══════════════════════════════════════════");

  checkNode();

  npm(["install"], ROOT);
  npm(["install"], BACKEND);
  npm(["install"], FRONTEND);

  fixElectron();
  ensureEnv();
  ensureLexicon();

  if (withBibles) {
    npm(["run", "import-bibles"], BACKEND);
  } else if (!hasImportedBibles()) {
    console.log(
      "\n⚠ Aucun fichier bible dans backend/data/bibles/ (normal après un clone Git)."
    );
    console.log("  Pour les télécharger : npm run bootstrap:full");
    console.log("  ou : npm run import-bibles\n");
  } else {
    console.log("✓ Fichiers bible déjà présents");
  }

  console.log("\n═══════════════════════════════════════════");
  console.log("  ✅ Installation terminée");
  console.log("═══════════════════════════════════════════");
  console.log("\nProchaines étapes :");
  console.log("  1. Édite backend/.env (clés API, STT, bible…)");
  if (!withBibles && !hasImportedBibles()) {
    console.log("  2. npm run import-bibles   (ou bootstrap:full la prochaine fois)");
    console.log("  3. npm run dev");
  } else {
    console.log("  2. npm run dev");
  }
  console.log("");
}

main();
