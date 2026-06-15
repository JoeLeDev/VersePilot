# Guide d'installation — VersePilot Live

Application de détection de versets bibliques en direct, avec envoi vers ProPresenter et **dictée vocale incluse dans votre abonnement**.

---

## Prérequis

| Élément | Détail |
|--------|--------|
| **macOS** | 12 Monterey ou plus récent (Intel ou Apple Silicon) |
| **Windows** | 10 ou 11 (64 bits) |
| **ProPresenter** | 7 ou plus récent (pour l'affichage à l'écran) |
| **Internet** | **Requis pendant le culte** (dictée vocale temps réel) |
| **Abonnement** | Clé de licence préconfigurée — voir `GUIDE-ABONNEMENT.md` |

---

## Installation

### macOS (fichier `.dmg`)

1. Ouvrez le fichier `VersePilot Live-*.dmg` fourni.
2. Glissez **VersePilot Live** dans le dossier **Applications**.
3. **Première ouverture** (app non signée Apple) :
   - Clic droit sur l'icône → **Ouvrir**
   - Confirmez **Ouvrir** dans la boîte de dialogue
4. Au premier lancement, l'application crée sa configuration dans :
   ```
   ~/Library/Application Support/versepilot-live-desktop/.env
   ```
   Votre **clé de licence** y est déjà inscrite — ne la modifiez pas sauf demande du support.

### Windows (fichier `.exe`)

1. Lancez l'installeur `VersePilot Live Setup *.exe`.
2. Suivez les étapes (dossier par défaut recommandé).
3. Configuration utilisateur :
   ```
   %APPDATA%\versepilot-live-desktop\.env
   ```

---

## Premier lancement

1. Démarrez **VersePilot Live** et attendez que le moteur soit prêt (~30 s).
2. Ouvrez **ProPresenter** (voir `GUIDE-PROPRESENTER.md`).
3. Vérifiez l'indicateur **streaming** près du bouton live.
4. Choisissez **Micro** ou **Son système**, puis **Démarrer le live**.
5. Parlez : le texte doit apparaître en **temps réel** (quelques secondes max).

> Aucune clé API à saisir : la dictée est incluse dans votre abonnement.

---

## Utilisation rapide

1. **Source audio** : micro du prédicateur ou son système (partage d'écran + audio sur Mac).
2. **Démarrer le live** : transcription en direct.
3. Les **versets détectés** apparaissent à gauche.
4. **Afficher dans ProPresenter** : envoi manuel à l'écran.

---

## Dépannage

| Problème | Solution |
|---------|----------|
| App ne s'ouvre pas (Mac) | Clic droit → Ouvrir (première fois) |
| « Licence expirée / désactivée » | Contacter votre fournisseur VersePilot |
| Pas de texte en direct | Internet + micro + indicateur streaming |
| ProPresenter ne réagit pas | `GUIDE-PROPRESENTER.md` |
| Aucun verset trouvé | Parler plus clairement ou saisir la référence à la main |

---

## Documents fournis

| Guide | Contenu |
|-------|---------|
| `GUIDE-ABONNEMENT.md` | Abonnement, facturation, confidentialité |
| `GUIDE-PROPRESENTER.md` | Messages Reference + Verset |

**Support** : contactez la personne qui vous a fourni l'application.

Les guides sont aussi dans l'app installée : `Resources/docs/`
