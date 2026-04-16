
# Documentation du composant customRecordPicker

## Présentation

**customRecordPicker** est un composant Lightning Web Component (LWC) configurable qui reproduit et étend l’expérience du `lightning-record-picker` natif Salesforce. Il permet :

- **Profils d’affichage dynamiques** : affiche des sous-titres différents selon la valeur d’un champ discriminant (ex : `IsPersonAccount`, `RecordType.DeveloperName`)
- **Système de filtres avancés** : critères multiples, expressions logiques (`AND`, `OR`, `NOT`, parenthèses), prise en charge des littéraux de date Salesforce (`TODAY`, `LAST_MONTH`, ...)
- **Recherche multi-champs** : recherche sur plusieurs champs (String, Picklist)
- **Champs de relation** : traverse les relations (ex : `Owner.Name`, `RecordType.DeveloperName`)
- **Compatibilité Flow** : déclenche `FlowAttributeChangeEvent` si `useFlow = true`
- **Navigation clavier** : flèches, Entrée, Échap
- **API de validation** : méthodes `validate()` et `reportValidity()` compatibles avec la validation Flow

---

## Fichiers du composant

```
lwc/customRecordPicker/
├── customRecordPicker.html
├── customRecordPicker.js
├── customRecordPicker.css
├── customRecordPicker.js-meta.xml
├── customRecordPickerUtils.js          ← fonctions utilitaires
└── __tests__/
    ├── customRecordPicker.test.js      ← tests d’intégration
    └── customRecordPickerUtils.test.js ← tests unitaires
```

---

## API publique (`@api`)

| Propriété            | Type                | Défaut     | Description |
|----------------------|---------------------|------------|-------------|
| `config`             | Object \| String    | —          | Objet de configuration (ou chaîne JSON). **Obligatoire.** |
| `selectedRecordId`   | String              | —          | ID de l’enregistrement sélectionné (lecture/écriture). |
| `disabled`           | Boolean             | false      | Désactive le composant. |
| `width`              | String              | "640px"   | Largeur du composant (px, rem, em, %, vw, vh, auto). |
| `useFlow`            | Boolean             | false      | Si true, déclenche `FlowAttributeChangeEvent` lors d’un changement. |
| `isSelected`         | Boolean (readonly)  | false      | true si un enregistrement est sélectionné et chargé. |
| `hasError`           | Boolean (readonly)  | false      | true si une erreur de config, validation ou requête est active. |

### Méthodes

| Méthode              | Retourne                                   | Description |
|----------------------|--------------------------------------------|-------------|
| `validate()`         | `{ isValid: Boolean, errorMessage?: String }` | Vérifie la validité du champ et de la config. |
| `reportValidity()`   | Boolean                                    | Raccourci pour `validate().isValid`. |
| `clearSelection()`   | void                                       | Réinitialise la sélection et l’état interne. |

### Événements

| Événement | `detail`                        | Déclenché quand |
|-----------|----------------------------------|-----------------|
| `change`  | `{ recordId: String \| null }`   | Un enregistrement est sélectionné ou la sélection est effacée. |

---

## Propriété `config` — référence complète

La propriété `config` accepte un objet JavaScript ou une chaîne JSON.

```jsonc
{
  // ── Obligatoire ───────────────────────────────────────────────
  "objectApiName": "Account",           // API Name Salesforce de l’objet à rechercher
  "searchFields": [                     // Champs utilisés pour la recherche
    { "apiName": "Name" },              // Champ texte (par défaut, opérateur LIKE)
    { "apiName": "AccountSource", "dataType": "Picklist" } // Picklist (opérateur eq)
  ],

  // ── Affichage ────────────────────────────────────────────────
  "label": "Recherche Compte",           // Libellé affiché (défaut : "Rechercher un enregistrement")
  "placeholder": "Saisir pour rechercher…",    // Placeholder
  "titleField": "Name",                // Champ principal affiché (défaut : "Name")
  "subtitleFields": [                   // Champs secondaires (sous-titre)
    { "apiName": "BillingCity", "fieldLabel": "Ville" }
  ],
  "iconName": "standard:account",      // Icône SLDS

  // ── Comportement ─────────────────────────────────────────────
  "required": false,                    // Champ obligatoire pour la validation
  "maxResults": 10,                     // Nombre max de résultats (max 100)
  "minimumSearchLength": 2,            // Nb min de caractères avant recherche

  // ── Filtres ─────────────────────────────────────────────────
  "filter": {
    "criteria": [ /* voir référence filtre ci-dessous */ ],
    "filterLogic": "1 AND 2"            // Optionnel. Par défaut : AND de tous les critères.
  },

  // ── Profils d’affichage dynamiques ──────────────────────────
  "discriminator": "IsPersonAccount",  // Champ discriminant
  "displayProfiles": {                  // Clé = valeur du champ discriminant
    "true":  { "subtitleFields": [ … ] },
    "false": { "subtitleFields": [ … ] }
  }
}
```

### Détail des attributs de config

#### `objectApiName`
**Type** : String — **Obligatoire**
Nom API Salesforce de l’objet à rechercher. Exemples : `Account`, `Contact`, `Opportunity`, `CustomObject__c`.

#### `searchFields`
**Type** : Array<{ apiName: String, dataType?: String }> — **Obligatoire**
Liste des champs utilisés pour la recherche (OR logique entre eux). Chaque entrée :
- `apiName` (obligatoire) : nom du champ (ex : `Name`, `Phone`, `RecordType.DeveloperName`)
- `dataType` (optionnel) : "String" (LIKE) ou "Picklist" (eq)

Exemple :
```json
"searchFields": [
  { "apiName": "Name" },
  { "apiName": "Phone" },
  { "apiName": "AccountSource", "dataType": "Picklist" }
]
```

#### `label`
Libellé affiché au-dessus du champ (défaut : "Rechercher un enregistrement").

#### `placeholder`
Texte d’aide affiché dans le champ (défaut : vide).

#### `titleField`
Champ principal affiché dans chaque résultat et dans la pilule sélectionnée (défaut : `Name`).

#### `subtitleFields`
Champs secondaires affichés sous le titre (tableau d’objets `{ apiName, fieldLabel }`).
Peut être surchargé par `displayProfiles`.

Exemple :
```json
"subtitleFields": [
  { "apiName": "BillingCity",   "fieldLabel": "Ville"   },
  { "apiName": "AccountNumber", "fieldLabel": "Réf"    },
  { "apiName": "Owner.Name",    "fieldLabel": "Propriétaire"  }
]
```

#### `iconName`
Nom de l’icône SLDS (ex : `standard:account`).

#### `required`
Champ obligatoire pour la validation (`validate()`).

#### `maxResults`
Nombre maximum de résultats affichés (max 100).

#### `minimumSearchLength`
Nombre minimal de caractères avant déclenchement de la recherche (défaut : 2).

#### `filter`
Filtre statique appliqué à chaque recherche (en plus du terme saisi).

##### `filter.criteria`
Tableau de critères :
```json
{
  "fieldPath": "Type",         // Champ cible (relation possible)
  "operator": "eq",            // eq, ne, like, gt, gte, lt, lte, in, nin
  "value": "Customer - Direct" // Valeur (voir ci-dessous)
}
```
Valeurs supportées : String, ID Salesforce, Integer, Float, Boolean, littéral de date (`{ "literal": "TODAY" }`), null, tableau (pour in/nin).

##### `filter.filterLogic`
Expression logique combinant les critères (ex : `1 AND (2 OR 3)`).

##### Littéraux de date supportés
Tous les littéraux Salesforce GraphQL : `TODAY`, `YESTERDAY`, `TOMORROW`, `LAST_WEEK`, `THIS_WEEK`, `NEXT_WEEK`, `LAST_MONTH`, `THIS_MONTH`, `NEXT_MONTH`, `LAST_90_DAYS`, `NEXT_90_DAYS`, `THIS_YEAR`, `LAST_YEAR`, `NEXT_YEAR`, `LAST_N_DAYS:n`, `NEXT_N_DAYS:n`, etc.

#### `discriminator`
Champ discriminant pour appliquer dynamiquement un profil d’affichage (`displayProfiles`).
Exemples : `IsPersonAccount`, `RecordType.DeveloperName`, `Type`.

> **Important** : la comparaison se fait toujours sur la valeur string du champ. Pour les booléens, utiliser "true"/"false" comme clés.

#### `displayProfiles`
Objet `{ valeurDiscriminant: { subtitleFields: [...] } }`.
Permet de personnaliser dynamiquement les sous-titres selon la valeur du champ discriminant.

Exemple :
```json
"discriminator": "IsPersonAccount",
"displayProfiles": {
  "true": {
    "subtitleFields": [
      { "apiName": "LastName",        "fieldLabel": "Nom" },
      { "apiName": "PersonNumber__c", "fieldLabel": "N° de personne" }
    ]
  },
  "false": {
    "subtitleFields": [
      { "apiName": "AccountNumber",   "fieldLabel": "N° de compte" },
      { "apiName": "SIRETnumber__c",  "fieldLabel": "SIRET" }
    ]
  }
}
```

---

## Scénarios d’usage (exemples)

### 1 — Recherche minimale sur Contact
```json
{
  "label": "Contact",
  "objectApiName": "Contact",
  "titleField": "Name",
  "searchFields": [{ "apiName": "Name" }]
}
```

### 2 — Recherche multi-champs avec sous-titre
```json
{
  "label": "Compte",
  "objectApiName": "Account",
  "titleField": "Name",
  "searchFields": [
    { "apiName": "Name" },
    { "apiName": "Phone" }
  ],
  "subtitleFields": [
    { "apiName": "BillingCity", "fieldLabel": "Ville" },
    { "apiName": "AccountNumber", "fieldLabel": "Réf" }
  ],
  "iconName": "standard:account",
  "placeholder": "Recherche par nom ou téléphone…",
  "maxResults": 20
}
```

### 3 — Filtre sur valeur statique
```json
{
  "label": "Client",
  "objectApiName": "Account",
  "titleField": "Name",
  "searchFields": [{ "apiName": "Name" }],
  "filter": {
    "criteria": [
      {
        "fieldPath": "Type",
        "operator": "eq",
        "value": "Customer - Direct"
      }
    ]
  }
}
```

### 4 — Filtre sur littéral de date
```json
{
  "label": "Compte",
  "objectApiName": "Account",
  "titleField": "Name",
  "searchFields": [{ "apiName": "Name" }],
  "filter": {
    "criteria": [
      {
        "fieldPath": "LastModifiedDate",
        "operator": "lt",
        "value": { "literal": "TODAY" }
      }
    ]
  }
}
```

### 5 — Filtres multiples avec filterLogic
```json
{
  "label": "Compte récent",
  "objectApiName": "Account",
  "titleField": "Name",
  "searchFields": [{ "apiName": "Name" }],
  "filter": {
    "criteria": [
      {
        "fieldPath": "CreatedDate",
        "operator": "gte",
        "value": { "literal": "LAST_90_DAYS" }
      },
      {
        "fieldPath": "Type",
        "operator": "eq",
        "value": "Customer - Direct"
      },
      {
        "fieldPath": "Type",
        "operator": "eq",
        "value": "Partner"
      }
    ],
    "filterLogic": "1 AND (2 OR 3)"
  }
}
```

### 6 — Profils d’affichage dynamiques (discriminator)
```json
{
  "label": "Tiers payeurs",
  "objectApiName": "Account",
  "titleField": "Name",
  "searchFields": [
    { "apiName": "Name" },
    { "apiName": "AccountSource", "dataType": "Picklist" }
  ],
  "iconName": "standard:account",
  "discriminator": "IsPersonAccount",
  "displayProfiles": {
    "true": {
      "subtitleFields": [
        { "apiName": "LastName",        "fieldLabel": "Nom" },
        { "apiName": "PersonNumber__c", "fieldLabel": "N° de personne" }
      ]
    },
    "false": {
      "subtitleFields": [
        { "apiName": "AccountNumber",   "fieldLabel": "N° de compte" },
        { "apiName": "SIRETnumber__c",  "fieldLabel": "SIRET" }
      ]
    }
  },
  "placeholder": "Rechercher tiers payeur",
  "required": true,
  "maxResults": 50,
  "minimumSearchLength": 2
}
```

### 7 — Champs de relation
```json
{
  "label": "Opportunité",
  "objectApiName": "Opportunity",
  "titleField": "Name",
  "searchFields": [{ "apiName": "Name" }],
  "subtitleFields": [
    { "apiName": "Owner.Name",         "fieldLabel": "Propriétaire" },
    { "apiName": "Owner.Profile.Name", "fieldLabel": "Profil" },
    { "apiName": "StageName",          "fieldLabel": "Étape" }
  ],
  "iconName": "standard:opportunity"
}
```

### 8 — Filtrer par ID de parent
```json
{
  "label": "Contact",
  "objectApiName": "Contact",
  "titleField": "Name",
  "searchFields": [{ "apiName": "Name" }],
  "subtitleFields": [
    { "apiName": "Title", "fieldLabel": "Titre" }
  ],
  "filter": {
    "criteria": [
      {
        "fieldPath": "AccountId",
        "operator": "eq",
        "value": "001xx000003GHPYAA4"
      }
    ]
  }
}
```

### 9 — Utilisation dans un écran Flow
Définir `useFlow = true`. Le composant déclenche `FlowAttributeChangeEvent` lors d’un changement de sélection, ce qui permet au Flow de récupérer la variable `selectedRecordId`.

| Propriété            | Valeur |
|----------------------|--------|
| `config`             | Chaîne JSON de la config |
| `useFlow`            | `true` |
| `selectedRecordId`   | variable de sortie (ex : `{!varSelectedId}`) |

---

## Utilisation dans OmniScript

- Définir `useOmniscript = true`
- Le JSON de config doit être encapsulé dans des quotes simples (`'...'`)

Exemple :
```json
'{
  "label": "Recherche Compte",
  "objectApiName": "Account",
  "titleField": "Name",
  "searchFields": [ { "apiName": "Name" } ],
  "iconName": "standard:account"
}'
```

---

## Publication sur Confluence

- Copier ce contenu dans une page Confluence (format markdown ou wiki).
- Ajouter des exemples d’utilisation réels selon vos besoins métier.
- Pour toute question, contacter l’équipe Salesforce.

---

**Fin de la documentation**
