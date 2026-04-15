# SOSL avec WHERE Clauses - Guide Détaillé

## 🎯 La Nouvelle Stratégie (Beaucoup Plus Efficace)

```
Avant: FIND 'dupont*' RETURNING Account(fields)
       + Filtrer en mémoire sur searchFields
       = ❌ Peu flexible

Après: FIND 'dupont*' RETURNING Account(fields
       WHERE Name LIKE '%dupont%' 
          OR SIRETnumber__c LIKE '%dupont%'
          OR Enseigne__c LIKE '%dupont%'
       )
       + Critères additionnels en mémoire
       = ✅ Optimal !
```

Maintenant on combine les deux types de recherche dans la **même requête SOSL** !

---

## 📊 Wildcards - Comprendre la Différence

### FIND (dans `FIND 'searchTerm*'`)
**Utilisation:** Recherche full-text sur l'index Salesforce
**Wildcard:** `*` uniquement (pas de `%`)
**Position:** Généralement à la fin pour prefix matching
**Exemple:**
```
FIND 'dupont*' 
  ↓ Cherche l'index Salesforce
  ↓ Trouve les records avec "dupont" au début
  ✓ "Dupont SA", "Dupontier", "Dupon & Frères"
  ✗ "SARL Dupont" (Dupont n'est pas au début)
```

### LIKE (dans `WHERE field LIKE '%searchTerm%'`)
**Utilisation:** Pattern matching SOQL/SOSL après la recherche index
**Wildcard:** `%` (any characters) et `_` (single character)
**Position:** Flexible (début, milieu, fin)
**Exemple:**
```
WHERE Name LIKE '%dupont%'
  ↓ Cherche dans les résultats de FIND
  ↓ Trouve les records avec "dupont" PARTOUT
  ✓ "Dupont SA", "Dupontier", "SARL Dupont", "dup-ont"
```

---

## 🔍 Exemple Concret: Rechercher "82981070400017"

### Configuration LWC (inchangée)
```javascript
config = {
    "objectApiName": "Account",
    "searchFields": [
        { "apiName": "SIRETnumber__c" },
        { "apiName": "Enseigne__c" },
        { "apiName": "Name" }
    ],
    "filter": {
        "criteria": [
            { "fieldPath": "IsPersonAccount", "operator": "eq", "value": false }
        ],
        "filterLogic": "1"
    },
    "maxResults": 30
}
```

### Requête SOSL Construite (dans Apex)
```apex
FIND '*82981070400017*' 
IN ALL FIELDS 
RETURNING Account(
    Id, 
    Name, 
    Enseigne__c, 
    SIRETnumber__c, 
    IsPersonAccount
    WHERE 
        SIRETnumber__c LIKE '%82981070400017%' 
        OR Enseigne__c LIKE '%82981070400017%' 
        OR Name LIKE '%82981070400017%'
    LIMIT 30
)
```

### Étapes d'exécution

```
1️⃣ FIND '*82981070400017*' (Recherche simple sur l'index)
   └─ Cherche tous les records contenant "82981070400017"
   └─ Très rapide (index Salesforce)
   └─ Retourne ~100 records potentiels

2️⃣ WHERE SIRETnumber__c LIKE '%82981070400017%' OR ... (Filtrage LIKE)
   ├─ Vérifie que le SIRET contient la chaîne exacte
   ├─ OU que Enseigne contient la chaîne exacte
   ├─ OU que Name contient la chaîne exacte
   └─ Réduit à ~10 records pertinents

3️⃣ Critères additionnels en mémoire Apex (après SOSL)
   └─ IsPersonAccount = false (appliqué en mémoire par Apex)
   └─ Réduit à ~5 records final
```

**Total: ~50-100ms** (vs ~300ms avec filtrage post-search complet)

---

## ⚙️ Wildcards: Quand les utiliser?

### Cas 1: Recherche au début (PREFIX MATCH) - Plus rapide
```javascript
searchTerm: "dupont"

// FIND (index)
FIND 'dupont*'           // ✅ Rapide - prefix
FIND '*dupont'           // ❌ Lent - full-text (pas d'index)
FIND '*dupont*'          // ❌ Très lent - full-text both ends

// WHERE (LIKE)
WHERE Name LIKE 'dupont%'           // ✅ Rapide (prefix)
WHERE Name LIKE '%dupont%'          // ⚠️ Lent (no prefix index)
```

### Cas 2: Recherche partout dans le texte - Nécessaire pour LIKE
```javascript
searchTerm: "dupont"

WHERE Name LIKE '%dupont%'          // ✅ Recherche partout
// TROUVE: "Dupont SA", "SARL Dupont", "A. Dupont", "Du Pont"

WHERE Name LIKE 'dupont%'           // ⚠️ Seulement au début
// TROUVE: "Dupont SA", "Dupontier"
// PERTE: "SARL Dupont"
```

### Cas 3: Exact match (pas de wildcard)
```javascript
searchTerm: "dupont"

WHERE Name = 'dupont'               // ✅ Match exact seulement
// TROUVE: "dupont"
// PERTE: "Dupont", "Dupont SA", "dupont inc"
```

---

## 💡 Notre Stratégie Optimale

### ✅ Combo FIND + WHERE LIKE
```apex
// FIND: Prefix wildcard (rapide index)
// WHERE: Both-side wildcard (flexible matching)

String searchTerm = "dupont";

String soslTerm = searchTerm + '*';           // "dupont*" pour FIND
String likeSearchTerm = '%' + searchTerm + '%';  // "%dupont%" pour LIKE

FIND 'dupont*' RETURNING Account(
    fields
    WHERE Name LIKE '%dupont%'
       OR SIRETnumber__c LIKE '%dupont%'
       OR Enseigne__c LIKE '%dupont%'
)
```

**Avantages:**
- ✅ FIND utilise l'index (rapide)
- ✅ WHERE LIKE affine précisément sur les champs souhaités
- ✅ Cherche partout dans les trois champs (prefix, milieu, fin)
- ✅ Pas de filtrage post-search en mémoire

---

## 🔐 Sanitization

### Pour FIND (caractères spéciaux SOSL)
```apex
String searchTerm = "test&query!";
String sanitized = sanitizeSoslTerm(searchTerm);  
// Résultat: "test\&query\!"
// Échappe: ? & | ! { } [ ] ( ) ^ ~ : \ " ' + -
```

### Pour LIKE (caractères SOQL)
```apex
String searchTerm = "dupont%toto_test";
String sanitized = sanitizeLikeTerm(searchTerm);
// Résultat: "dupont\%toto\_test"
// Échappe: % _ \
```

---

## 📝 Code Apex Complet

```apex
private static String buildSoslQuery(SearchRequest request) {
    String searchTerm = sanitizeSoslTerm(request.searchTerm);
    
    // FIND: Prefix wildcard (rapide)
    String soslTerm = searchTerm + '*';
    
    // Construire les champs à retourner
    List<String> allFields = new List<String>{'Id'};
    if (request.searchFields != null && !request.searchFields.isEmpty()) {
        for (String field : request.searchFields) {
            if (!allFields.contains(field)) {
                allFields.add(field);
            }
        }
    }
    
    // Construire WHERE clause avec LIKE sur searchFields
    String whereClause = '';
    if (request.searchFields != null && !request.searchFields.isEmpty()) {
        List<String> searchConditions = new List<String>();
        String likeSearchTerm = '%' + sanitizeLikeTerm(request.searchTerm) + '%';
        
        for (String field : request.searchFields) {
            searchConditions.add(field + ' LIKE \'' + likeSearchTerm + '\'');
        }
        
        if (!searchConditions.isEmpty()) {
            whereClause = ' WHERE ' + String.join(searchConditions, ' OR ');
        }
    }
    
    // Construire la requête complète
    Integer resultLimit = Math.min(request.maxResults, MAX_RESULTS_CAP);
    String query = 'FIND \'' + soslTerm + '\' IN ALL FIELDS RETURNING ' +
                   request.objectApiName + '(' + String.join(allFields, ', ') + 
                   whereClause + ' LIMIT ' + resultLimit + ')';
    
    return query;
}
```

### Requête Générée
```sql
FIND 'dupont*' 
IN ALL FIELDS 
RETURNING Account(
    Id, Name, Enseigne__c, SIRETnumber__c 
    WHERE Name LIKE '%dupont%'
       OR Enseigne__c LIKE '%dupont%'
       OR SIRETnumber__c LIKE '%dupont%'
    LIMIT 30
)
```

---

## ✅ Résumé: Quand utiliser quoi

| Contexte | Wildcard | Raison |
|----------|----------|--------|
| **FIND (index)** | `dupont*` | Prefix matching rapide sur index |
| **WHERE LIKE** | `%dupont%` | Recherche partout dans le champ |
| **WHERE = (exact)** | Aucun | Match exact uniquement |

---

## 🚀 Migration du LWC

Le LWC **ne change pas**. La config reste pareille :

```javascript
// Avant (GraphQL) ❌
// Après (Apex) ✅

config = {
    objectApiName: "Account",
    searchFields: [  // ← Ces champs sont maintenant utilisés dans WHERE LIKE
        { apiName: "Name" },
        { apiName: "SIRETnumber__c" },
        { apiName: "Enseigne__c" }
    ],
    // ...
}
```

Le LWC appelle simplement:
```javascript
const request = {
    searchTerm: "dupont",
    objectApiName: "Account",
    searchFields: ["Name", "SIRETnumber__c", "Enseigne__c"],
    maxResults: 30,
    criteria: [...],
    filterLogic: "1"
};

const results = await search({ request });
```

L'Apex s'occupe de tout le reste ! 🎯

---

## 📚 Références

- [SOSL Syntax - Salesforce Docs](https://developer.salesforce.com/docs/atlas.en-us.soql_sosl.meta/soql_sosl/sforce_api_calls_sosl.htm)
- [LIKE Operator - SOQL Docs](https://developer.salesforce.com/docs/atlas.en-us.soql_sosl.meta/soql_sosl/sforce_api_calls_sosl_like.htm)
- [Performance Best Practices](https://developer.salesforce.com/docs/atlas.en-us.soql_sosl.meta/soql_sosl/sforce_api_calls_sosl_best_practices.htm)
