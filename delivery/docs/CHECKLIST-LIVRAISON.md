# Checklist livraison client — VersePilot Live

Liste pour préparer une livraison avec **abonnement dictée vocale** (Deepgram via proxy).

---

## Avant le build

- [ ] Node.js 18+ sur la machine de build
- [ ] `npm run release` (importe bibles + index sémantique + modèle e5 **automatiquement**)
- [ ] Louis Segond présent : `backend/data/bibles/louis-segond.json`
- [ ] Index sémantique : `backend/data/bibles/louis-segond.local.embeddings.bin`
- [ ] Modèle e5 : `backend/models/transformers/` (requêtes hors-ligne)
- [ ] Lexique : `backend/data/biblical-lexicon.json`
- [ ] **Proxy licence** déployé (ou clé Deepgram directe pour 1er client)
- [ ] `delivery/default.env` personnalisé pour l'église
- [ ] Guides à jour dans `delivery/docs/`

---

## Configuration licence (par église)

### Étape 1 — Créer la licence sur ton serveur

Dans `services/license-proxy/licenses.json` :

```json
{
  "key": "VP-EGLISE-2026-A1B2",
  "church": "Nom de l'église",
  "active": true,
  "expiresAt": "2027-06-30T23:59:59.000Z",
  "maxMinutesPerMonth": 600
}
```

Redémarrer le proxy : `npm start` dans `services/license-proxy/`.

### Étape 2 — Personnaliser `delivery/default.env`

```bash
STT_MODE=deepgram
VERSEPILOT_LICENSE_KEY=VP-EGLISE-2026-A1B2
VERSEPILOT_PROXY_URL=https://api.versepilot.tondomaine.fr
DEEPGRAM_API_KEY=
```

### Étape 3 — Build

```bash
npm run release:mac   # ou release:win
```

> Le `.env` est copié au **premier lancement** uniquement. Si le client a déjà l'app, éditer son `.env` manuellement.

### Mode rapide (1er client, sans proxy)

```bash
STT_MODE=deepgram
DEEPGRAM_API_KEY=ta_cle_deepgram
VERSEPILOT_LICENSE_KEY=
VERSEPILOT_PROXY_URL=
```

---

## Contenu livré au client

| Élément | Fichier |
|---------|---------|
| Installeur | `dist/VersePilot Live-*.dmg` ou `.exe` |
| Guide installation | `delivery/docs/GUIDE-INSTALLATION.md` |
| Guide abonnement | `delivery/docs/GUIDE-ABONNEMENT.md` |
| Guide ProPresenter | `delivery/docs/GUIDE-PROPRESENTER.md` |
| Contrat / facturation | À ton initiative (hors repo) |

---

## Test avant envoi

- [ ] App installée sans cloner le dépôt
- [ ] **Aucun bandeau** « Installer les Bibles » / « Générer l'index » (tout est embarqué)
- [ ] Indicateur **streaming** visible
- [ ] Dictée temps réel fluide (parler 30 s)
- [ ] Détection verset + envoi ProPresenter OK
- [ ] `GET /health` → `licenseMode: true`, `streamingAvailable: true`
- [ ] Désactiver `active: false` sur la licence → erreur claire

Test licence :

```bash
curl -H "X-VersePilot-License: VP-..." https://api.versepilot.tondomaine.fr/v1/license/status
```

---

## Gestion abonnement

| Action | Comment |
|--------|---------|
| Nouveau client | Ajouter entrée `licenses.json` + rebuild avec sa clé |
| Renouvellement | Prolonger `expiresAt` |
| Impayé | `"active": false` |
| Quota dépassé | Augmenter `maxMinutesPerMonth` ou contacter client |

---

## Ce qui n'est PAS dans l'installeur

| Élément | Raison |
|---------|--------|
| Clé Deepgram maître | Sur ton proxy uniquement |
| Signature Apple | Hors scope actuel |
| Python / terminal | **Rien à installer côté client** — bibles + index + modèle e5 inclus |
| Whisper / MLX | Secours optionnel, pas requis avec abonnement |

---

## Prix indicatif à facturer

| Forfait | Cultes/mois | Prix conseillé |
|---------|-------------|----------------|
| Essentiel | 4 × 1 h | 15–20 €/mois |
| Standard | 8 × 1 h30 | 25–35 €/mois |

Coût API Deepgram : ~0,25 €/h de culte.
