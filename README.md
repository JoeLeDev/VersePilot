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

- Node.js 18+ (pour `fetch` natif et `--watch`)
- Clé API OpenAI uniquement si `SEARCH_MODE=ai` ou `hybrid` avec fallback
- ProPresenter 7 avec le **Network → Enable Network** activé (par défaut port `50001`)
- (Option voix offline) `whisper.cpp` installe localement + un modele `.bin`

## Installation

### 0. Mode desktop (Electron)

Depuis la racine du projet :

```bash
npm install
```

Puis installer les dépendances de chaque app :

```bash
cd backend && npm install
cd ../frontend && npm install
cd ..
```

Lancer l'application desktop en mode dev :

```bash
npm run dev
```

Construire une app macOS (`.dmg`) :

```bash
npm run dist:mac
```

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env
# Édite .env et ajoute ta clé OPENAI_API_KEY
npm run dev
```

Le backend tourne sur `http://localhost:4000`.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Ouvre `http://localhost:5173`. Le proxy Vite redirige automatiquement les appels vers le backend.

## Configuration ProPresenter

Le bouton ⚙ dans la barre du haut ouvre la configuration. Par défaut :

| Champ | Valeur |
|---|---|
| IP | `127.0.0.1` (ou IP de la machine ProPresenter sur le réseau local) |
| Port | `50001` |
| Nom du Message | `Verset` |
| Token référence | `Reference` |
| Token texte | `Texte` |

**Dans ProPresenter**, créer un **Message** nommé `Verset` qui contient deux tokens texte : `Reference` et `Texte`. La mise en page (police, taille, placement) se gère côté ProPresenter — VersePilot ne fait que pousser les valeurs.

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
  "textTokenName": "Texte",
  "reference": "Jean 3:16",
  "text": "Car Dieu a tant aimé le monde..."
}
```
→ Déclenche le Message ProPresenter avec les valeurs fournies.

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
# VersePilot
