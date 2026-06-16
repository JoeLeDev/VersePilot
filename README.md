# VersePilot Live

> MVP V1 — Régie biblique assistée par IA, avec dispatch vers ProPresenter.

Un outil pensé pour la régie : retrouver en quelques secondes un verset à partir d'une phrase entendue, d'une référence approximative ou d'un mot-clé, puis l'envoyer à ProPresenter **sur validation manuelle uniquement**.

## Architecture

```
versepilot-live/
├── backend/        # Express + OpenAI + ProPresenter HTTP
│   ├── server.js
│   ├── data/bibles/          # un JSON par version (voir data/bibles/README.md)
│   ├── data/verses.json      # échantillon de secours (56 versets)
│   └── .env
└── frontend/       # React + Vite
    └── src/
```

## Prérequis

| Outil | Version | Notes |
|-------|---------|--------|
| **Node.js** | 18+ (20 LTS recommandé) | `node -v` et `npm -v` |
| **Git** | récent | pour cloner le dépôt |
| **ProPresenter 7+** | réseau activé | port par défaut `50001` (le tien peut être `49354`) |

**Optionnel selon usage :**
- Clé **OpenAI** — seulement si `SEARCH_MODE=ai` ou `hybrid`
- Clé **Deepgram** — transcription temps réel (`STT_MODE=deepgram`)
- **Python 3** + MLX — Apple Silicon uniquement (`npm run mlx-stt`)
- **whisper.cpp** — transcription 100 % locale (`STT_MODE=local`)

> **macOS** : Electron + son système fonctionnent mieux dans la fenêtre desktop.  
> **Windows / Linux** : l’app tourne, mais le **son système** pour la capture n’est pas garanti (utilise le micro).

---

## Installation (nouvelle machine)

### Étape 1 — Installation automatique (recommandé)

À la **racine** du projet, **une seule commande** :

```bash
git clone <url-du-repo> versepilot-live
cd versepilot-live

npm run bootstrap
```

Ce script enchaîne :
- `npm install` (racine + backend + frontend)
- réparation du binaire **Electron** (`electron:fix`)
- création de `backend/.env` depuis `.env.example` si absent
- génération du lexique STT si besoin

**Avec les bibles** (15 versions, plusieurs minutes — réseau requis) :

```bash
npm run bootstrap:full
```

Vérification Electron :

```bash
npx electron --version
```

### Étape 1 bis — Installation manuelle

Si tu préfères faire étape par étape :

```bash
npm install
npm run setup
npm run electron:fix
cp backend/.env.example backend/.env
```

### Étape 2 — Configurer le backend

```bash
cp backend/.env.example backend/.env
```

Édite `backend/.env` au minimum :

```bash
PORT=4000
SEARCH_MODE=offline
STT_MODE=deepgram          # ou local / mlx sur Mac Apple Silicon
DEEPGRAM_API_KEY=          # si STT_MODE=deepgram
BIBLE_VERSION=louis-segond
```

### Étape 3 — Données bibliques (recommandé)

Les gros fichiers JSON **ne sont pas dans Git**. Sur chaque machine :

```bash
cd backend
npm run import-bibles       # ~15 versions FR/EN (quelques minutes)
npm run build-lexicon       # lexique STT (déjà généré si biblical-lexicon.json présent)
cd ..
```

### Étape 4 — Lancer l’application

**Mode desktop (recommandé en régie)** — depuis la racine :

```bash
npm run dev
```

Cela démarre en parallèle :
1. Backend → `http://localhost:4000`
2. Frontend Vite → `http://localhost:5173`
3. Fenêtre **Electron** (ne pas utiliser seulement l’onglet Chrome)

**Mode navigateur seul** (sans Electron) — deux terminaux :

```bash
# Terminal 1
cd backend && npm run dev

# Terminal 2
cd frontend && npm run dev
```

Puis ouvre `http://localhost:5173` — **micro uniquement**, pas le son système ProPresenter.

### Étape 5 — Build installable (optionnel)

```bash
# macOS (.dmg)
npm run dist:mac

# Windows (.exe) — lancer sur une machine Windows
npm run dist:win
```

Le fichier sort dans `dist/`.

---

## Dépannage installation Electron

### `Electron failed to install correctly, please delete node_modules/electron and try installing again`

Message typique quand le **binaire Electron** (~100 Mo) n’a pas fini de se télécharger (réseau coupé, antivirus, `npm install` interrompu).

**À la racine du projet** :

```bash
# 1. Nettoyer uniquement Electron (plus rapide)
rm -rf node_modules/electron

# 2. Retélécharger le binaire
npm install
npm run electron:fix

# 3. Vérifier
npx electron --version
```

Si ça échoue encore, **réinstall complète** :

```bash
rm -rf node_modules package-lock.json
npm cache clean --force
npm install
npm run setup
npm run electron:fix
npx electron --version
```

**Réseau lent / proxy / pare-feu** :

```bash
export ELECTRON_GET_USE_PROXY=1
npm install
npm run electron:fix
```

**Windows (PowerShell)** — remplacer `rm -rf` par :

```powershell
Remove-Item -Recurse -Force node_modules\electron
npm install
npm run electron:fix
```

**Node.js** : utilise la **v20 LTS** ou **v22 LTS** ([nodejs.org](https://nodejs.org)). Les versions très récentes (ex. v25) peuvent parfois poser problème avec les scripts d’install.

### `electron: command not found` ou pas de fenêtre au `npm run dev`

```bash
# À la racine du projet (pas dans backend/)
rm -rf node_modules package-lock.json
npm install
npx electron --version
```

### Erreur réseau au téléchargement d’Electron (`ECONNRESET`, `ETIMEDOUT`)

Electron télécharge un binaire (~80–150 Mo) au premier `npm install`.

```bash
# Réessayer avec cache propre
npm cache clean --force
npm install

# Si proxy d’entreprise / réseau lent :
export ELECTRON_GET_USE_PROXY=1
npm install
```

### `npm run dev` : backend OK mais pas de fenêtre

- Attendre que **4000** et **5173** répondent (le script utilise `wait-on`).
- Vérifier qu’aucun autre process n’occupe ces ports.
- Lancer manuellement : `npx electron .` (à la racine, avec backend + frontend déjà up).

### Windows : échec `npm install` à la racine

- Node **64 bits** (pas 32 bits) : [https://nodejs.org](https://nodejs.org)
- Terminal **PowerShell ou CMD en administrateur** si erreur de permissions.
- Antivirus : parfois bloque le binaire Electron — autoriser le dossier du projet.

### Linux

Non testé officiellement. Prérequis usuels pour Electron :

```bash
sudo apt install libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils
```

### Checklist rapide nouvelle machine

```
[ ] node -v  → 18+ (20 LTS idéal)
[ ] npm run bootstrap
[ ] npx electron --version  → OK
[ ] éditer backend/.env
[ ] npm run import-bibles  (si pas bootstrap:full)
[ ] npm run dev
```

---

## Installation (détail par composant)

### Backend seul

```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

→ `http://localhost:4000`

### Frontend seul

```bash
cd frontend
npm install
npm run dev
```

→ `http://localhost:5173` (proxy API vers `:4000`)

## Configuration ProPresenter

Le bouton ⚙ dans la barre du haut ouvre la configuration. Par défaut :

| Champ | Valeur |
|---|---|
| IP | `127.0.0.1` (ou IP de la machine ProPresenter sur le réseau local) |
| Port | `50001` |
| Nom du Message | `Verset` |
| Token référence | `Reference` |
| Token texte | `Verset` |

**Mode deux messages** (référence et verset sur des calques séparés) : créer dans ProPresenter un message `Reference` (jeton `Reference`, thème petit) et un message `Verset` (jeton `Verset` uniquement, thème grand). Activer « Deux messages séparés » dans ⚙ VersePilot.

**Mode message unique** : un seul message `Verset` avec les jetons `Reference` et `Verset`.

> Préférences > Network > **Enable Network** doit être coché.

## Endpoints backend

### `POST /search-verse`
```json
{ "query": "celui qui croit en moi aura la vie" }
```
→ Retourne 1 à 3 suggestions avec référence, version, texte, et justification.

### Mode de recherche (offline / hybrid / ai)

Le backend supporte 3 modes via la variable d'environnement `SEARCH_MODE` :

- `offline` (défaut) : recherche locale uniquement, sans internet ni OpenAI
- `hybrid` : offline d'abord, fallback OpenAI si aucun résultat
- `ai` : OpenAI uniquement

Exemple dans `backend/.env` :

```bash
SEARCH_MODE=offline
SEMANTIC_SEARCH=openai
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

**Recherche sémantique (OpenAI embeddings, recommandé)** — une fois par bible :

```bash
npm run build-embeddings
# ou: cd backend && npm run build-embeddings -- louis-segond darby
```

Coût indicatif ~0,03 $ pour Louis Segond (31k versets). Pendant le culte : 1 embedding par phrase (~quelques centimes/heure). Sans index, la recherche reste lexicale uniquement.

### Dictée vocale (interface)

Dans **Transcription live** :

- **Source audio** : micro ou **son système** (partage d’écran avec piste audio ; macOS : cocher « Partager l’audio »)
- **Microphone** : liste des entrées (mémorisée)
- **Niveau audio** : barre en temps réel + seuil « Signal OK »
- **Effacer** : vide la transcription sans arrêter la dictée

### Dictée vocale (local / OpenAI cloud)

Par défaut : `STT_MODE=local` dans `backend/.env`.

- `local` : whisper.cpp sur ton Mac (gratuit, offline)
- `openai` : API OpenAI (meilleure qualité, internet requis, ~0,003 $/min)
- `hybrid` : OpenAI d'abord, fallback local si erreur

Exemple test cloud (prédication 1h-1h30) :

```bash
STT_MODE=openai
OPENAI_API_KEY=sk-...
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
```

Endpoint principal : `POST /transcribe`  
Fallback local force : `POST /transcribe-offline`

### Bibles complètes (un JSON par version)

Chaque traduction est dans son **propre fichier** sous `backend/data/bibles/` (pas de mélange entre versions).

```bash
cd backend
npm run import-bibles          # 15 versions FR + EN (recommandé)
npm run import-bibles:all      # ~140 versions (long)
```

Puis dans `.env` :

```bash
BIBLE_VERSION=fre-crampon
```

Versions prioritaires (culte) : Louis Segond, Darby, Français courant (+ placeholders Segond 21, Semeur, PDV, etc.).  
`npm run import-bibles -- --legacy` pour Crampon, KJV, etc.  
Liste : `GET /bible/versions` · détail : `backend/data/bibles/README.md`

### Dictée vocale offline (whisper.cpp)

L'app peut transcrire l'audio du micro en local via l'endpoint `POST /transcribe-offline`.

Configuration `backend/.env` :

```bash
WHISPER_MODE=local
WHISPER_BIN=whisper-cli
WHISPER_MODEL_PATH=/chemin/vers/ggml-medium-q5_0.bin
WHISPER_LANG=fr
WHISPER_BEAM_SIZE=5
WHISPER_THREADS=6
WHISPER_SUPPRESS_NST=true
WHISPER_CARRY_PROMPT=true
WHISPER_USE_VAD=true
WHISPER_NO_GPU=true
# WHISPER_PROMPT=optionnel (whisper.cpp local uniquement)
# OPENAI_TRANSCRIBE_PROMPT=phrase courte (ne pas lister tous les livres — sinon écho dans la dictée)
```

Notes:

- la capture audio se fait dans le frontend, puis la transcription est realisee en local dans le backend
- pas de cloud requis pour cette transcription
- si `whisper-cli` ou le modele est manquant, un message d'erreur explicite est renvoye
- mode precision recommande (M2 16 Go): `ggml-medium-q5_0.bin` + `WHISPER_BEAM_SIZE=5`
- le prompt biblique est genere automatiquement depuis les livres de la bible active
- sur macOS, si Whisper plante avec `GGML_ASSERT` / Metal: garde `WHISPER_NO_GPU=true` (mode CPU stable)

### `POST /send-to-propresenter`
```json
{
  "ip": "127.0.0.1",
  "port": 50001,
  "messageId": "optional-uuid",
  "messageName": "Verset",
  "refTokenName": "Reference",
  "textTokenName": "Verset",
  "reference": "Jean 3:16",
  "text": "Car Dieu a tant aimé le monde..."
}
```
→ Déclenche le Message ProPresenter avec les valeurs fournies.

## Livraison client (application locale + abonnement STT)

Pour préparer un **installeur** à remettre au client :

```bash
npm run release:mac    # .dmg macOS (non signé)
npm run release:win    # installeur Windows NSIS
npm run release:dir    # dossier .app / test rapide
```

### Avant livraison — configurer la licence client

1. Éditer `delivery/default.env` :
   ```bash
   STT_MODE=deepgram
   VERSEPILOT_LICENSE_KEY=VP-EGLISE-2026-XXXX
   VERSEPILOT_PROXY_URL=https://api.versepilot.tondomaine.fr
   DEEPGRAM_API_KEY=
   ```
2. Ajouter la même clé dans `services/license-proxy/licenses.json` sur ton serveur.
3. Rebuild : `npm run release:mac`

**1er client (rapide)** : tu peux mettre `DEEPGRAM_API_KEY` directement dans le `.env` client sans proxy.

### Proxy d'abonnement (multi-clients)

```bash
cd services/license-proxy
cp .env.example .env && cp licenses.example.json licenses.json
npm install && npm start
```

Voir `services/license-proxy/README.md` pour le déploiement VPS, quotas et désactivation impayés.

### Documents à joindre au client

| Fichier | Description |
|---------|-------------|
| `delivery/docs/GUIDE-INSTALLATION.md` | Installation |
| `delivery/docs/GUIDE-ABONNEMENT.md` | Abonnement dictée incluse |
| `delivery/docs/GUIDE-PROPRESENTER.md` | ProPresenter |

**macOS non signé** : clic droit → Ouvrir la première fois.

Voir `delivery/docs/CHECKLIST-LIVRAISON.md` pour la checklist complète.

## Architecture backend (refactor en cours)

```
backend/
├── config/env.js          # chargement + validation .env
├── routes/                # routes Express (ProPresenter…)
├── services/
│   ├── searchService.js   # recherche offline (testée)
│   └── propresenterService.js
├── utils/text.js          # normalize, parseReferenceString
└── server.js              # point d'entrée (STT encore ici)
```

Tests : `npm test` (backend + frontend) · CI : `.github/workflows/ci.yml`

## UX régie

| Fonction | Détail |
|---------|--------|
| **Mode démo** | Bouton « Démo » — simule l'écran ProPresenter |
| **Mode Live** | Interface agrandie · raccourci `⌘L` |
| **Raccourcis 1-2-3** | Envoie les 3 premiers résultats |
| **Historique** | Envois avec nom de culte + renvoi |
| **Confirmation** | Toast vert après envoi |

## Garde-fou

Aucun envoi vers ProPresenter ne se déclenche automatiquement. Le bouton **"Afficher dans ProPresenter"** est le seul déclencheur.

## Évolutions V2 envisagées

- Base complète (Segond 21, BDS, Colombe, NEG)
- Embeddings + recherche sémantique offline (pour éliminer la dépendance OpenAI sur scène)
- Historique des envois pendant le service
- Mode hors-ligne : pré-calcul des suggestions avant le culte
- Raccourcis clavier `1` / `2` / `3` pour envoyer le résultat correspondant
- Aperçu plein écran du verset avant envoi
- Multi-cible : envoyer sur plusieurs instances ProPresenter (audience + stage display)
