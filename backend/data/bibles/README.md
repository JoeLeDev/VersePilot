# Bibles — un fichier JSON par version

Chaque traduction a **son propre fichier** (`slug.json`) pour ne jamais mélanger les textes.

## Versions prioritaires (culte FR)

| Fichier | Traduction | Statut |
|---------|------------|--------|
| `louis-segond.json` | Louis Segond 1910 | ✅ open data (helloao / eBible) |
| `darby.json` | Bible J.N. Darby | ✅ open data |
| `francais-courant.json` | Bible en français courant 1997 | ✅ data.gouv.fr |
| `segond-21.json` | Segond 21 | ⛔ copyright — placeholder vide |
| `semeur.json` | Bible du Semeur | ⛔ copyright — placeholder vide |
| `bible-expliquee.json` | Bible expliquée | ⛔ copyright — placeholder vide |
| `parole-de-vie-2017.json` | Parole de Vie 2017 | ⛔ copyright — placeholder vide |

Pour les versions ⛔, tu peux remplacer le fichier par un export licencié (même structure `meta` + `verses`).

## Importer

```bash
cd backend
npm run import-bibles
```

Versions anciennes (scrollmapper, EN, etc.) :

```bash
npm run import-bibles -- --legacy
```

## Choisir la version active

```bash
# backend/.env
BIBLE_VERSION=louis-segond
```

Redémarrer le backend après import ou changement.

Corriger les noms de livres (ex. `I chronicles` → `1 Chroniques`) :

```bash
npm run fix-book-names
# ou: npm run fix-book-names -- louis-segond
```

## Recherche sémantique (OpenAI, style Pewbeam)

Une fois une bible importée :

```bash
cd backend
npm run build-embeddings
# ou: npm run build-embeddings -- louis-segond darby
```

Coût indicatif : **~0,03 $** par bible indexée (31k versets).  
Pendant le culte : **< 0,01 $/h** (1 embedding par phrase analysée).

Dans `.env` :

```bash
SEMANTIC_SEARCH=openai
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
SEARCH_MODE=offline
```

Fichiers générés : `louis-segond.embeddings.bin` + `.embeddings.meta.json` (non versionnés git, volumineux).

## Format

```json
{
  "meta": {
    "slug": "louis-segond",
    "code": "LSG",
    "name": "Louis Segond (1910)",
    "available": true,
    "verseCount": 31102
  },
  "verses": [
    { "book": "Jean", "chapter": 3, "verse": 16, "version": "LSG", "text": "..." }
  ]
}
```
