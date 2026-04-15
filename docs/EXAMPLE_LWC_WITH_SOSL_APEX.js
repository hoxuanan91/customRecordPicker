/**
 * customRecordPicker - Integration avec SOSL Apex
 * 
 * ✅ STRATÉGIE:
 *   1. LWC traite la configuration (comme avant) ✓
 *   2. LWC envoie searchFields et searchTerm à l'Apex
 *   3. Apex construit la requête SOSL avec WHERE LIKE sur searchFields
 *   4. LWC affiche les résultats (comme avant)
 * 
 * Configuration inchangée - c'est transparent !
 */

import { LightningElement, api } from "lwc";
import { getRecord } from "lightning/uiRecordApi";
import { FlowAttributeChangeEvent } from "lightning/flowSupport";
import { OmniscriptBaseMixin } from "vlocity_ins/omniscriptBaseMixin";

// ✅ NOUVEAU: Import de l'Apex method
import search from "@salesforce/apex/CustomRecordPickerSearchController.search";

const DEBOUNCE_DELAY = 300;
const MAX_RESULTS_CAP = 100;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MIN_SEARCH_LENGTH = 2;
const DEFAULT_PLACEHOLDER = "Rechercher...";
const DEFAULT_ERROR_MESSAGE = "Complétez ce champ.";
const EMPTY_MESSAGE = "Aucun résultat trouvé";

export default class CustomRecordPicker extends OmniscriptBaseMixin(
    LightningElement
) {
    // API (inchangé)
    @api disabled;
    @api width;
    @api useOmniscript = false;
    @api useFlow = false;
    @api outputKey = "selectedRecord";

    // Configuration (IDENTIQUE - pas de changement ✓)
    _config = {
        "label": "Tiers payeurs",
        "objectApiName": "Account",
        "titleField": "Name",
        "discriminator": "IsPersonAccount",
        "displayProfiles": {
            "true": {
                "subtitleFields": [
                    { "apiName": "FirstName", "fieldLabel": "Prénom" },
                    { "apiName": "LastName", "fieldLabel": "Nom" }
                ]
            },
            "false": {
                "subtitleFields": [
                    { "apiName": "Name", "fieldLabel": "Raison sociale" },
                    { "apiName": "Enseigne__c", "fieldLabel": "Enseigne" }
                ]
            }
        },
        // ✅ Ces searchFields sont maintenant utilisées dans la requête SOSL WHERE LIKE
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
    };

    _value;
    _selectedTitle;
    _selectedSubtitle;
    _selectedRecord;
    _outputFields = [];
    _searchTerm;
    _isDropdownOpen = false;
    _highlightedIndex = -1;
    _isLoading = false;
    _errorMessage;
    _validationError;
    _configError;
    _debounceTimer;
    _results = [];

    // ─── CONFIG & GETTERS (inchangés) ───────────────────────────────────

    @api
    get config() {
        return this._config;
    }
    set config(val) {
        this._configError = undefined;
        if (typeof val === "string" && val) {
            try {
                this._config = parseLooseJsonString(val);
            } catch {
                this._config = {};
                this._configError = "Configuration invalide: le JSON fourni est incorrect.";
            }
        } else if (val && typeof val === "object") {
            this._config = val;
        } else {
            this._config = {};
        }
        this._validateConfiguration();
    }

    get _cfg() {
        const c = this._config || {};
        return {
            label: c.label || "Rechercher un enregistrement",
            objectApiName: c.objectApiName,
            titleField: c.titleField || "Name",
            subtitleFields: c.subtitleFields || [],
            // ✅ searchFields sont maintenant utilisés par l'Apex dans WHERE LIKE
            searchFields: (Array.isArray(c.searchFields) ? c.searchFields : [])
                .map((field) =>
                    typeof field === "string"
                        ? { apiName: field, dataType: "String" }
                        : { ...field, dataType: field.dataType || "String" },
                ),
            filter: c.filter,
            required: c.required || false,
            maxResults: Math.min(c.maxResults || DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP),
            minimumSearchLength: c.minimumSearchLength ?? DEFAULT_MIN_SEARCH_LENGTH,
        };
    }

    get _searchFieldsArray() {
        return this._cfg.searchFields;
    }

    @api
    get selectedRecordId() {
        return this._value;
    }
    set selectedRecordId(val) {
        this._value = val;
        if (!val) {
            this._selectedTitle = undefined;
            this._selectedSubtitle = undefined;
            this._selectedRecord = undefined;
        }
    }

    // ─── SEARCH: handleInput ───────────────────────────────────────────────

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
                // ✅ NOUVEAU: Appeler la recherche Apex
                this._executeApexSearch();
            } else {
                this._isLoading = false;
                this._isDropdownOpen = false;
                this._results = [];
            }
        }, DEBOUNCE_DELAY);
    }

    // ─── EXECUTE APEX SEARCH ────────────────────────────────────────────────
    // ✅ NOUVEAU: Méthode qui appelle l'Apex

    async _executeApexSearch() {
        if (!this._searchTerm || 
            this._searchTerm.length < this._cfg.minimumSearchLength) {
            this._results = [];
            this._isLoading = false;
            return;
        }

        this._isLoading = true;
        this._errorMessage = undefined;

        try {
            // ✅ Construire la requête pour l'Apex
            // Format : { searchTerm, objectApiName, searchFields, criteria, filterLogic, maxResults }
            const request = {
                searchTerm: this._searchTerm,
                objectApiName: this._cfg.objectApiName,
                // ✅ searchFields: Les champs où chercher (utilisés dans WHERE LIKE)
                searchFields: this._cfg.searchFields.map(f => f.apiName),
                // ✅ criteria: Les filtres additionnels (appliqués après SOSL)
                criteria: this._cfg.filter?.criteria || [],
                filterLogic: this._cfg.filter?.filterLogic,
                maxResults: this._cfg.maxResults
            };

            console.log("📤 [SOSL Apex] Search request:", {
                searchTerm: request.searchTerm,
                searchFields: request.searchFields,
                criteria: request.criteria,
                object: request.objectApiName
            });

            // ✅ Appeler l'Apex method
            const results = await search({ request });

            console.log("📥 [SOSL Apex] Results received:", results.length + " records");

            this._errorMessage = undefined;

            // ✅ Transformer les résultats Apex pour le template
            this._results = results.map((result) => {
                return {
                    id: result.id,
                    title: result.fields.Name || result.fields[this._cfg.titleField] || "",
                    subtitle: this._buildSubtitleFromFields(result.fields),
                    node: result.fields
                };
            });

        } catch (error) {
            console.error("❌ [SOSL Apex] Search error:", error);
            this._errorMessage = error?.body?.message || error.message || "Erreur lors de la recherche";
            this._results = [];

        } finally {
            this._isLoading = false;
        }
    }

    // ─── HELPERS ─────────────────────────────────────────────────────────────

    _buildSubtitleFromFields(fields) {
        const subtitleFields = this._cfg.subtitleFields || [];
        if (!subtitleFields.length) return undefined;

        const parts = subtitleFields
            .map((field) => {
                const value = fields[field.apiName];
                return value ? `${field.fieldLabel} : ${value}` : null;
            })
            .filter(Boolean);

        return parts.length ? parts.join(" | ") : undefined;
    }

    _validateConfiguration() {
        if (this._configError) return;

        try {
            const rawConfig = this._config || {};

            if (!rawConfig.objectApiName || !rawConfig.objectApiName.trim()) {
                throw new Error("Configuration invalide: objectApiName est obligatoire.");
            }

            if (rawConfig.searchFields && !Array.isArray(rawConfig.searchFields)) {
                throw new Error("Configuration invalide: searchFields doit être un tableau.");
            }
        } catch (e) {
            this._configError = e.message;
        }
    }

    // ─── TEMPLATE GETTERS ────────────────────────────────────────────────────

    get isSelected() {
        return !!this._value && !!this._selectedTitle;
    }
    get hasResults() {
        return this._results.length > 0;
    }
    get showDropdown() {
        return (
            this._isDropdownOpen &&
            this._searchTerm &&
            (this.hasResults || this._isLoading)
        );
    }
    get displayResults() {
        return this._results.map((item, index) => ({
            ...item,
            optionIndex: String(index),
            optionClass: `slds-media slds-listbox__option${
                index === this._highlightedIndex ? " slds-has-focus" : ""
            }`
        }));
    }

    // ─── EVENT HANDLERS (inchangés avec la logique SOSL) ─────────────────────

    handleFocus() {
        if (this.isSelected) return;
        if (
            this._searchTerm &&
            this._searchTerm.length >= this._cfg.minimumSearchLength
        ) {
            this._isDropdownOpen = true;
        }
    }

    handleKeyDown(event) {
        if (this.isSelected) return;
        switch (event.key) {
            case "ArrowDown":
                event.preventDefault();
                this._moveHighlight(1);
                break;
            case "ArrowUp":
                event.preventDefault();
                this._moveHighlight(-1);
                break;
            case "Enter":
                event.preventDefault();
                if (
                    this._highlightedIndex >= 0 &&
                    this._highlightedIndex < this._results.length
                ) {
                    this._selectItem(this._results[this._highlightedIndex]);
                }
                break;
            case "Escape":
                this._closeDropdown();
                break;
        }
    }

    handleOptionClick(event) {
        const item = this._results.find(
            (r) => r.id === event.currentTarget.dataset.id,
        );
        if (item) {
            this._selectItem(item);
        }
    }

    _moveHighlight(delta) {
        const newIndex = this._highlightedIndex + delta;
        if (newIndex >= 0 && newIndex < this._results.length) {
            this._highlightedIndex = newIndex;
        }
    }

    _closeDropdown() {
        this._isDropdownOpen = false;
    }

    _selectItem(item) {
        this._value = item.id;
        this._selectedTitle = item.title;
        this._selectedSubtitle = item.subtitle;
        this._selectedRecord = item.node;
        this._isDropdownOpen = false;
        this._searchTerm = undefined;
        this._results = [];

        // Dispatch change event
        this.dispatchEvent(
            new CustomEvent("change", {
                detail: {
                    recordId: this._value,
                    record: this._selectedRecord
                }
            })
        );

        // Fire Flow event if needed
        if (this.useFlow) {
            this.dispatchEvent(
                new FlowAttributeChangeEvent(this.outputKey, this._value)
            );
        }
    }

    @api clearSelection() {
        this._value = undefined;
        this._selectedTitle = undefined;
        this._selectedSubtitle = undefined;
        this._selectedRecord = undefined;
        this._searchTerm = undefined;
        this._results = [];
    }

    @api validate() {
        if (this._configError) {
            return { isValid: false, errorMessage: this._configError };
        }
        if (this._cfg.required && !this._value) {
            this._validationError = "Ce champ est obligatoire.";
            return { isValid: false, errorMessage: this._validationError };
        }
        this._validationError = undefined;
        return { isValid: true };
    }
}

// ─── UTILS ──────────────────────────────────────────────────────────────────

function parseLooseJsonString(raw) {
    if (typeof raw !== "string") return raw;
    let normalized = raw.trim();
    if (normalized.startsWith("\\'")) {
        normalized = normalized.slice(2);
    } else if (normalized.startsWith("'")) {
        normalized = normalized.slice(1);
    }
    if (normalized.endsWith("\\'")) {
        normalized = normalized.slice(0, -2);
    } else if (normalized.endsWith("'")) {
        normalized = normalized.slice(0, -1);
    }
    normalized = normalized.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(normalized);
}
