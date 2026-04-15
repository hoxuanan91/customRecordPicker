# Guide d'Implémentation : Migration du LWC vers SOSL Apex

## Vue d'ensemble

Ce guide montre comment modifier le composant LWC `customRecordPicker` pour utiliser la nouvelle classe Apex `CustomRecordPickerSearchController` qui implémente SOSL dynamique.

## Changements Clés

### 1. Imports du Composant

**AVANT** (GraphQL - ne fonctionne pas) :
```javascript
import { gql, graphql } from "lightning/uiGraphQLApi";

@wire(graphql, { query: "$_graphqlQuery", variables: "$_graphqlVariables" })
_wiredSearchResults({ data, errors }) { ... }
```

**APRÈS** (Apex SOSL) :
```javascript
import search from "@salesforce/apex/CustomRecordPickerSearchController.search";

// Plus de @wire, appel direct asynchrone au lieu de réactif
```

### 2. Suppression de la Logique GraphQL

**À SUPPRIMER de `customRecordPicker.js` :**

```javascript
// ❌ Ces fonctions ne sont plus nécessaires

function fieldToGraphQL(fieldPath) { ... }
function fieldPathToWhereNesting(fieldPath) { ... } 
function serializeWhereClause(node) { ... }
function serializeDateValue(value) { ... }
function inferGraphQLType(value) { ... }

get _graphqlQuery() { 
    // ❌ Plus de construction de requête GraphQL
    return gql`...`;
}

get _graphqlVariables() {
    // ❌ Plus de variables GraphQL
    return { soslTerm: ..., ...filterVariables };
}

get _filterData() {
    // ❌ Restructurer pour l'Apex au lieu de GraphQL
    ...
}
```

### 3. Nouvelle Logique de Recherche

**Remplacer le handler `handleInput`** :

```javascript
import search from "@salesforce/apex/CustomRecordPickerSearchController.search";

// Ancien code - @wire réactif
@wire(graphql, { query: "$_graphqlQuery", variables: "$_graphqlVariables" })
_wiredSearchResults({ data, errors }) {
    // GraphQL wire adapter
}

// NOUVEAU code - appel Apex asynchrone
async _executeSearch() {
    if (!this._searchTerm || 
        this._searchTerm.length < this._cfg.minimumSearchLength) {
        this._results = [];
        this._isLoading = false;
        return;
    }

    this._isLoading = true;
    this._errorMessage = undefined;

    try {
        // Construire la requête de recherche
        const request = {
            searchTerm: this._searchTerm,
            objectApiName: this.objectApiName,
            searchFields: this._searchApiNames,       // List<String>
            maxResults: this._cfg.maxResults,
            criteria: this._cfg.filter?.criteria || [], // List<FilterCriterion>
            filterLogic: this._cfg.filter?.filterLogic  // String
        };

        console.log("Apex search request:", request);
        
        // Appeler l'Apex method
        const results = await search({ request });
        
        console.log("Apex search results:", results);
        
        this._errorMessage = undefined;
        
        // Convertir les résultats Apex au format attendu par le template
        this._results = results.map((result) => {
            const profile = this._resolveProfileForFields(result.fields);
            const effectiveTitleField = profile?.titleField || this.titleField;
            
            return {
                id: result.id,
                title: this._extractApexFieldValue(result.fields, effectiveTitleField),
                subtitle: this._buildApexSubtitle(result.fields, profile),
                node: result.fields
            };
        });
        
    } catch (error) {
        console.error("Apex search error:", error);
        this._errorMessage = error?.body?.message || error.message || "Erreur lors de la recherche";
        this._results = [];
    } finally {
        this._isLoading = false;
    }
}

// Adapter le debounce pour appeler la nouvelle fonction
handleInput(event) {
    const term = event.detail.value;
    this._validationError = undefined;
    this._errorMessage = undefined;

    if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
    }

    this._debounceTimer = setTimeout(() => {
        this._searchTerm = term;
        this._highlightedIndex = -1;

        this._validateConfiguration();
        if (this._configError) {
            this._isLoading = false;
            this._isDropdownOpen = false;
            this._results = [];
            return;
        }

        if (term && term.length >= this._cfg.minimumSearchLength) {
            this._isDropdownOpen = true;
            // ✅ NOUVEAU : Appeler la nouvelle fonction de recherche
            this._executeSearch();
        } else {
            this._isLoading = false;
            this._isDropdownOpen = false;
            this._results = [];
        }
    }, DEBOUNCE_DELAY);
}
```

### 4. Helpers pour Traiter les Résultats Apex

Replacez les fonctions `_readNodeField` par des versions adaptées aux résultats SOSL :

```javascript
/**
 * Extraire une valeur de champ des résultats Apex
 * Les résultats Apex retournent des objets plats avec nom du champ comme clé
 * 
 * Exemple:
 *   Apex retourne: { fields: { Name: "Dupont SA", Type: "Customer" } }
 */
_extractApexFieldValue(fields, fieldPath) {
    const parts = fieldPath.split(".");
    let current = fields;
    
    for (let i = 0; i < parts.length; i++) {
        if (!current) return "";
        
        const part = parts[i];
        const value = current[part];
        
        if (value === undefined || value === null) return "";
        
        // Dernier niveau - retourner la valeur
        if (i === parts.length - 1) {
            // Si c'est un objet avec displayValue, l'utiliser
            if (typeof value === "object" && value.displayValue != null) {
                return value.displayValue;
            }
            return value != null ? String(value) : "";
        }
        
        // Parcourir les niveaux imbriqués
        if (typeof value === "object" && value !== null) {
            current = value;
        } else {
            return "";
        }
    }
    
    return "";
}

/**
 * Construire le sous-titre à partir des champs Apex
 */
_buildApexSubtitle(fields, profile) {
    const subtitleFields = profile?.subtitleFields || this._subtitleFieldsArray;
    if (!subtitleFields.length) return undefined;
    
    const parts = subtitleFields
        .map((field) => {
            const value = this._extractApexFieldValue(fields, field.apiName);
            return value ? `${field.fieldLabel} : ${value}` : null;
        })
        .filter(Boolean);
    
    return parts.length ? parts.join(" | ") : undefined;
}
```

### 5. Gestion des Erreurs Apex

Remplacer le traitement des erreurs GraphQL :

```javascript
// ❌ ANCIEN - Erreurs GraphQL
if (errors) {
    console.error("customRecordPicker: SOSL GraphQL error", JSON.stringify(errors));
    const messages = [];
    for (const err of errors) {
        if (err.errorType === "adapterError" && Array.isArray(err.error)) {
            for (const inner of err.error) {
                const msg = inner.message || "";
                // ...parsing des erreurs GraphQL
            }
        }
    }
}

// ✅ NOUVEAU - Erreurs Apex
catch (error) {
    console.error("Apex search error:", error);
    
    // Structure des erreurs Apex
    if (error.body?.message) {
        // Apex error message
        this._errorMessage = error.body.message;
    } else if (error.body?.exceptionType === 'AuraHandledException') {
        // Custom Apex exception
        this._errorMessage = error.body.message;
    } else if (error.message) {
        // JavaScript error
        this._errorMessage = error.message;
    } else {
        this._errorMessage = "Erreur inconnue lors de la recherche";
    }
    
    this._results = [];
}
```

### 6. Configuration du LWC

Aucun changement d'API publique. La configuration reste compatible :

```javascript
// Configuration existante - compatible
{
    "label": "Tiers payeurs",
    "objectApiName": "Account",
    "titleField": "Name",
    "searchFields": [
        { "apiName": "SIRETnumber__c" },
        { "apiName": "Enseigne__c" },
        { "apiName": "Name" }
    ],
    "filter": {
        "criteria": [
            { "fieldPath": "IsPersonAccount", "operator": "eq", "value": true }
        ],
        "filterLogic": "1"
    },
    "maxResults": 30,
    "minimumSearchLength": 2
}
```

## Code Complet (vue d'ensemble)

Le LWC modifié gardera la même structure mais avec :

✅ Import Apex au lieu de GraphQL
✅ Fonction `_executeSearch()` asynchrone
✅ Appel à `search({ request })`
✅ Traitement des résultats Apex (`result.id`, `result.fields`)
✅ Gestion d'erreurs Apex
✅ Même interface de configuration

```
before:  import { graphql } from "lightning/uiGraphQLApi"
         @wire(graphql, { query, variables })
         _wiredSearchResults({ data, errors })
         
after:   import search from "@salesforce/apex/..."
         async _executeSearch()
         await search({ request })
```

## Checklist de Migration

- [ ] Supprimer les imports GraphQL
- [ ] Importer l'Apex method: `import search from "@salesforce/apex/CustomRecordPickerSearchController.search";`
- [ ] Supprimer la logique de construction de query GraphQL
- [ ] Implémenter `_executeSearch()` avec appel Apex
- [ ] Modifier `handleInput()` pour appeler `_executeSearch()`
- [ ] Adapter les helpers `_extractApexFieldValue()` et `_buildApexSubtitle()`
- [ ] Tester les erreurs Apex
- [ ] Exécuter les tests existants
- [ ] Valider en Scratch Org

## Points Importants

⚠️ **SOSL vs SOQL**
- SOSL cherche sur l'**index de recherche** (performant)
- Les critères de filtre additionnels sont appliqués **en mémoire** dans l'Apex
- Cela reste plus performant que SOQL pour les cas d'usage de Record Picker

⚠️ **Sécurité**
-  La classe Apex inclut `with sharing` pour respecter RLS
- Tous les paramètres sont validés
- Pas de risque d'injection SOSL

⚠️ **Limites**
- Max 100 résultats (limite Salesforce)
- Query governor limits pour SOSL (10k characters)
- Performance dépend de l'indexation

## Tests

Exécuter les tests Apex :
```bash
sfdx force:apex:test:run -n CustomRecordPickerSearchControllerTest -r human
```

## Rollback

Si vous changez d'avis, la classe Apex peut coexister avec GraphQL - le LWC décidera qui appeler.
