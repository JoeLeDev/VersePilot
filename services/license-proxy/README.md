# VersePilot License Proxy

Serveur intermédiaire pour le modèle **abonnement mensuel** : ta clé Deepgram reste sur ce serveur, chaque église reçoit uniquement une **clé de licence** (`VP-…`).

## Architecture

```
App église (Electron)          Ton serveur (VPS)           Deepgram
─────────────────────          ─────────────────           ────────
VERSEPILOT_LICENSE_KEY    →    valide la licence      →   API STT
VERSEPILOT_PROXY_URL           clé Deepgram maître
(pas de DEEPGRAM_API_KEY)
```

## Installation (ton serveur)

```bash
cd services/license-proxy
cp .env.example .env
cp licenses.example.json licenses.json
# Éditer .env : DEEPGRAM_API_KEY=...
npm install
npm start
```

Port par défaut : **4100**.

## Déploiement production (recommandé)

| Étape | Détail |
|-------|--------|
| Hébergement | VPS (Hetzner, OVH, Railway, Fly.io…) |
| HTTPS | Obligatoire — Caddy ou nginx + Let's Encrypt |
| URL | Ex. `https://api.versepilot.tondomaine.fr` |
| Process | `pm2 start server.js --name versepilot-proxy` |
| Secrets | `.env` jamais dans Git |

Le client configure :

```bash
VERSEPILOT_LICENSE_KEY=VP-XXXX-XXXX
VERSEPILOT_PROXY_URL=https://api.versepilot.tondomaine.fr
STT_MODE=deepgram
DEEPGRAM_API_KEY=
```

## Gestion des licences

Fichier `licenses.json` :

```json
{
  "licenses": [
    {
      "key": "VP-EGLISE-0001-ABCD",
      "church": "Église Saint-Exemple",
      "contact": "regie@eglise.fr",
      "active": true,
      "plan": "standard",
      "expiresAt": "2027-06-30T23:59:59.000Z",
      "maxMinutesPerMonth": 600
    }
  ]
}
```

| Champ | Description |
|-------|-------------|
| `key` | Clé remise au client (format libre, ex. `VP-…`) |
| `active` | `false` = couper l'accès (impayé) |
| `expiresAt` | Fin d'abonnement |
| `maxMinutesPerMonth` | Plafond anti-abus (~600 min = 10 h/mois) |

### Créer une licence pour un nouveau client

1. Générer une clé unique : `VP-{ÉGLISE}-{ANNÉE}-{4 caractères}`
2. Ajouter l'entrée dans `licenses.json`
3. Redémarrer le proxy (ou recharger — aujourd'hui au démarrage)
4. Livrer la clé + URL proxy dans le `.env` client (voir checklist livraison)

### Désactiver un client (impayé)

```json
"active": false
```

Redémarrer le proxy. L'app affichera une erreur de licence au culte suivant.

## Endpoints

| Méthode | Chemin | Auth | Rôle |
|---------|--------|------|------|
| GET | `/health` | — | Santé du proxy |
| GET | `/v1/license/status` | `X-VersePilot-License` | Statut abonnement |
| POST | `/v1/transcribe` | idem | Transcription bloc |
| WS | `/v1/stt/stream?sampleRate=16000` | header licence | Streaming temps réel |

Test statut :

```bash
curl -s -H "X-VersePilot-License: VP-DEMO-0001-AAAA" \
  http://localhost:4100/v1/license/status
```

## Coût & facturation

Indicatif Deepgram Nova-3 : ~0,004 €/min → **1 h de culte ≈ 0,25 €**.

| Forfait client | Cultes/mois | Coût API | Prix conseillé |
|----------------|-------------|----------|----------------|
| Essentiel | 4 × 1 h | ~1 € | 15–20 €/mois |
| Standard | 8 × 1 h30 | ~3 € | 25–35 €/mois |

Marge + support + mises à jour.

## Phase 1 vs Phase 2

| Phase | Méthode | Quand |
|-------|---------|-------|
| **1** | `DEEPGRAM_API_KEY` directe dans le `.env` client | 1er client, mise en service rapide |
| **2** | Proxy + `VERSEPILOT_LICENSE_KEY` | 2+ clients, contrôle abonnement |

Les deux modes sont supportés par l'app desktop.

## Évolutions possibles

- Stripe webhook → activer/désactiver `active` automatiquement
- Base Postgres au lieu de `licenses.json`
- Dashboard conso par église
- Rotation des clés sans réinstaller l'app
