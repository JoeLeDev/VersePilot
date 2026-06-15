# Guide ProPresenter — VersePilot Live

Configuration recommandée pour afficher **référence** et **texte du verset** via l'API Messages de ProPresenter.

---

## Prérequis ProPresenter

- ProPresenter **7+** ouvert sur la même machine (ou accessible en réseau local).
- API réseau activée : **ProPresenter → Réglages → Réseau → Activer le réseau**.
- Port par défaut : **50001** (ProPresenter 7) ou **49354** (certaines versions / Remote).

Dans VersePilot Live, renseignez l'**IP** et le **port** dans la section ProPresenter (ex. `127.0.0.1` et `49354`).

---

## Créer les messages

Créez **deux messages** distincts dans ProPresenter (Bibliothèque → Messages) :

### Message 1 : `Reference`

- Nom du message : **Reference**
- Contenu du slide / template :
  ```
  {Reference}
  ```
- Un seul jeton dynamique nommé exactement **`Reference`**.

### Message 2 : `Verset`

- Nom du message : **Verset**
- Contenu du slide / template :
  ```
  {Verset}
  ```
- Un seul jeton dynamique nommé exactement **`Verset`**.

> **Important** : ne mettez pas `{Reference}` dans le message Verset. Sinon, en mode double envoi, le texte de référence peut écraser l'autre message.

---

## Configuration dans VersePilot Live

Dans le panneau **ProPresenter** :

| Champ | Valeur |
|-------|--------|
| IP | `127.0.0.1` (même machine) |
| Port | `49354` ou `50001` selon votre version |
| Message référence | `Reference` |
| Jeton référence | `Reference` |
| Message verset | `Verset` |
| Jeton verset | `Verset` |
| **Mode double messages** | **Activé** |

Cliquez **Tester la connexion** pour vérifier que ProPresenter répond.

---

## Ordre d'affichage

En mode **double messages** (recommandé), VersePilot envoie :

1. D'abord le **texte du verset** (message `Verset`)
2. Puis la **référence** (message `Reference`), avec un court délai (~220 ms)

Cela évite que ProPresenter n'affiche qu'un seul des deux contenus.

---

## Envoyer un verset

1. Détectez ou sélectionnez un verset dans VersePilot.
2. Cliquez **Afficher dans ProPresenter**.
3. Vérifiez à l'écran : référence + texte doivent apparaître sur vos sorties configurées.

Aucun envoi automatique : le bouton reste le seul déclencheur.

---

## Dépannage

| Symptôme | Cause probable | Action |
|---------|----------------|--------|
| Connexion refusée | API réseau désactivée | Activer le réseau dans ProPresenter |
| Mauvais port | Version PP différente | Essayer `49354` puis `50001` |
| Seul le verset s'affiche | Template mixte ou ordre | Vérifier que `Verset` ne contient que `{Verset}` |
| Jeton vide | Nom de jeton incorrect | Respecter la casse : `Reference`, `Verset` |
| Message introuvable | Nom différent | Aligner les noms avec la config VersePilot |

### Vérifier les messages via l'API (avancé)

Si ProPresenter écoute sur le port 49354 :

```bash
curl -s "http://127.0.0.1:49354/v1/libraries" | head
```

Dans VersePilot, le bouton diagnostic liste les messages et jetons détectés.

---

## Réseau (machine distante)

Si ProPresenter tourne sur un autre ordinateur du réseau local :

1. Notez l'adresse IP de la machine ProPresenter (ex. `192.168.1.50`).
2. Autorisez le port dans le pare-feu.
3. Dans VersePilot : IP `192.168.1.50`, même port qu'en local.

---

## Récapitulatif minimal

```
ProPresenter                    VersePilot Live
─────────────                   ───────────────
Message "Reference"      ←      refTokenName: Reference
  jeton {Reference}               messageName: Reference

Message "Verset"         ←      textTokenName: Verset
  jeton {Verset}                  messageName: Verset

Mode double messages : ON
```
