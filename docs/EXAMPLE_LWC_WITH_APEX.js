/**
 * customRecordPickerApexVersion.js
 * 
 * Exemple de code LWC modifié pour utiliser SOSL Apex
 * au lieu de GraphQL (qui ne supporte pas SOSL)
 * 
 * Changements clés :
 * 1. Import Apex au lieu de GraphQL
 * 2. Appel asynchrone search() au lieu de @wire(graphql)
 * 3. Traitement des résultats Apex (structure plate vs GraphQL nested)
 */

import { LightningElement, api, wire } from "lwc";
import { getRecord } from "lightning/uiRecordApi";
import { FlowAttributeChangeEvent } from "lightning/flowSupport";
import { OmniscriptBaseMixin } from "vlocity_ins/omniscriptBaseMixin";

// ✅ NOUVEAU : Import Apex method
import search from "@salesforce/apex/CustomRecordPickerSearchController.search";

// Constants (inchangé)
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

    _config = { /* configuration */ };
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
    _clickOutsideHandler;
    _results = [];

    // ─── Wire: fetch selected record (inchangé) ──────────────────────────────

    get _selectedRecordFields() {
        if (!this._value || !this.objectApiName || !this.titleField)
            return undefined;
        return this._allQueryApiNames.map(
            (f) => `${this.objectApiName}.${f}`,
        );
    }

    @wire(getRecord, { recordId: "$_value", fields: "$_selectedRecordFields" })
    _wiredSelectedRecord({ data, error }) {
        if (data) {
            const profile = this._resolveProfileForFields(data.fields);
            const effectiveTitleField =
                profile?.titleField || this.titleField;
            this._selectedTitle = this._extractFieldValue(
                data.fields,
                effectiveTitleField,
            );
            this._selectedSubtitle = this._buildSelectedSubtitle(
                data.fields,
                profile,
            );
            this._selectedRecord = this._buildOutputRecordFromFields(data.fields);
        }
        if (error) {
            console.error("customRecordPicker: Error loading selected record", error);
        }
    }

    // ─── HANDLE INPUT: Trigger Apex search ────────────────────────────────────
    // ✅ CHANGÉ : Appeler _executeSearch() au lieu de @wire

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
                // ✅ NOUVEAU : Appeler la méthode Apex au lieu de dépendre de @wire
                this._executeSearch();
            } else {
                this._isLoading = false;
                this._isDropdownOpen = false;
                this._results = [];
            }
        }, DEBOUNCE_DELAY);
    }

    // ─── EXECUTE APEX SEARCH ─────────────────────────────────────────────────
    // ✅ ENTIÈREMENT NOUVEAU : Appel asynchrone à Apex

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
            // Structure correspondant à la classe Apex SearchRequest
            const request = {
                searchTerm: this._searchTerm,
                objectApiName: this.objectApiName,
                searchFields: this._searchApiNames,           // List
                maxResults: this._cfg.maxResults,
                criteria: this._cfg.filter?.criteria || [],  // List
                filterLogic: this._cfg.filter?.filterLogic   // String
            };

            console.log("📤 Apex search request:", request);

            // ✅ Appeler l'Apex method et attendre la réponse
            const results = await search({ request });

            console.log("📥 Apex search results:", results);

            this._errorMessage = undefined;

            // ✅ Transformer les résultats Apex au format attendu par le template
            this._results = results.map((result) => {
                // result = { id: "001xx...", fields: { Name: "Dupont", Type: "Customer", ... } }
                const profile = this._resolveProfileForFields(result.fields);
                const effectiveTitleField = profile?.titleField || this.titleField;

                return {
                    id: result.id,
                    title: this._extractApexFieldValue(result.fields, effectiveTitleField),
                    subtitle: this._buildApexSubtitle(result.fields, profile),
                    node: result.fields  // Gardé pour compatibilité
                };
            });

        } catch (error) {
            console.error("❌ Apex search error:", error);
            
            // ✅ Gérer les erreurs Apex
            if (error.body?.message) {
                this._errorMessage = error.body.message;
            } else if (error.message) {
                this._errorMessage = error.message;
            } else {
                this._errorMessage = "Erreur inconnue lors de la recherche";
            }

            this._results = [];

        } finally {
            this._isLoading = false;
        }
    }

    // ─── APEX RESULT HELPERS ──────────────────────────────────────────────────
    // ✅ ADAPTÉS : Traiter les résultats Apex (structure plate)

    /**
     * Extraire une valeur de champ des résultats Apex
     * 
     * Les résultats Apex SOSL retournent une structure plate :
     *   { id: "001xx", fields: { Name: "X", Type: "Y", Parent: "Z" } }
     * 
     * vs GraphQL qui retourne imbriquée :
     *   { node: { Id: "001xx", Name: { displayValue: "X" }, ... } }
     */
    _extractApexFieldValue(fields, fieldPath) {
        if (!fields || !fieldPath) return "";

        const parts = fieldPath.split(".");
        let current = fields;

        for (let i = 0; i < parts.length; i++) {
            if (!current) return "";

            const part = parts[i];
            const value = current[part];

            if (value === undefined || value === null) return "";

            // Niveau final - retourner la valeur
            if (i === parts.length - 1) {
                // Si c'est un objet avec displayValue, l'utiliser
                if (typeof value === "object" && value?.displayValue != null) {
                    return value.displayValue;
                }
                return String(value);
            }

            // Parcourir les niveaux imbriqués (pour champs relationnels)
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

    // ─── Existing Helpers (inchangés) ────────────────────────────────────────

    get _cfg() {
        const c = this._config || {};
        return {
            label: c.label || "Rechercher un enregistrement",
            objectApiName: c.objectApiName,
            titleField: c.titleField || "Name",
            subtitleFields: c.subtitleFields || [],
            searchFields: (Array.isArray(c.searchFields) ? c.searchFields : [])
                .map((field) =>
                    typeof field === "string"
                        ? { apiName: field, dataType: "String" }
                        : { ...field, dataType: field.dataType || "String" },
                ),
            iconName: c.iconName,
            placeholder: c.placeholder || DEFAULT_PLACEHOLDER,
            filter: c.filter,
            discriminator: c.discriminator || undefined,
            displayProfiles: c.displayProfiles || undefined,
            required: c.required || false,
            maxResults: Math.min(
                c.maxResults || DEFAULT_MAX_RESULTS,
                MAX_RESULTS_CAP,
            ),
            minimumSearchLength:
                c.minimumSearchLength ?? DEFAULT_MIN_SEARCH_LENGTH,
            messageWhenValueMissing:
                c.messageWhenValueMissing || DEFAULT_ERROR_MESSAGE,
            outputFields: Array.isArray(c.outputFields) ? c.outputFields : [],
        };
    }

    get label() { return this._cfg.label; }
    get objectApiName() { return this._cfg.objectApiName; }
    get titleField() { return this._cfg.titleField; }
    get iconName() { return this._cfg.iconName; }
    get required() { return this._cfg.required; }
    get placeholder() { return this._cfg.placeholder; }

    get _subtitleFieldsArray() { return this._cfg.subtitleFields; }
    get _subtitleApiNames() {
        return this._subtitleFieldsArray.map((f) => f.apiName);
    }
    get _searchFieldsArray() { return this._cfg.searchFields; }
    get _searchApiNames() {
        return this._searchFieldsArray.map((f) => f.apiName);
    }

    get _allQueryApiNames() {
        const names = new Set();
        names.add(this.titleField);
        for (const f of this._subtitleApiNames) names.add(f);
        if (this._cfg.discriminator) names.add(this._cfg.discriminator);
        if (this._hasDisplayProfiles) {
            for (const profile of Object.values(this._cfg.displayProfiles)) {
                if (profile.titleField) names.add(profile.titleField);
                if (Array.isArray(profile.subtitleFields)) {
                    for (const f of profile.subtitleFields) names.add(f.apiName);
                }
            }
        }
        for (const f of this._outputFields) names.add(f);
        for (const f of this._cfg.outputFields) names.add(f);
        return [...names];
    }

    // Display profiles (inchangé)
    get _hasDisplayProfiles() {
        const cfg = this._cfg;
        return (
            !!cfg.discriminator &&
            !!cfg.displayProfiles &&
            Object.keys(cfg.displayProfiles).length > 0
        );
    }

    _getDisplayProfile(discriminatorValue) {
        if (!this._hasDisplayProfiles) return undefined;
        const key = String(discriminatorValue ?? "");
        return this._cfg.displayProfiles[key] || undefined;
    }

    _resolveProfileForNode(node) {
        if (!this._hasDisplayProfiles) return undefined;
        const val = node[this._cfg.discriminator];
        return this._getDisplayProfile(val);
    }

    _resolveProfileForFields(fields) {
        if (!this._hasDisplayProfiles) return undefined;
        const val = this._extractApexFieldValue(fields, this._cfg.discriminator);
        return this._getDisplayProfile(val);
    }

    // Template getters (inchangé)
    get isSelected() {
        return !!this._value && !!this._selectedTitle;
    }
    get hasResults() {
        return this._results.length > 0;
    }
    get hasIcon() {
        return !!this.iconName;
    }
    get emptyMessage() {
        return EMPTY_MESSAGE;
    }
    get listboxId() {
        return "listbox-options";
    }
    get showDropdown() {
        return (
            this._isDropdownOpen &&
            this._searchTerm != null &&
            this._searchTerm !== "" &&
            (this.hasResults || this._isLoading || this._showEmptyMessage)
        );
    }
    get _showEmptyMessage() {
        return (
            !this._isLoading &&
            !this.hasResults &&
            this._searchTerm &&
            this._searchTerm.length >= this._cfg.minimumSearchLength
        );
    }
    get hasError() {
        return !!this._configError || !!this._validationError || !!this._errorMessage;
    }
    get _displayError() {
        return this._configError || this._validationError || this._errorMessage;
    }
    get comboboxContainerClass() {
        return `slds-combobox_container${this.hasError ? " slds-has-error" : ""}`;
    }
    get displayResults() {
        return this._results.map((item, index) => ({
            ...item,
            optionIndex: String(index),
            optionClass: `slds-media slds-listbox__option slds-listbox__option_entity slds-listbox__option_has-meta${index === this._highlightedIndex ? " slds-has-focus" : ""}`,
            ariaSelected: index === this._highlightedIndex ? "true" : "false",
        }));
    }

    // Event handlers (inchangés)
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
            default:
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

    handleClear() {
        if (this.disabled) return;
        this.clearSelection();
        this._dispatchChange(null);
    }

    // Existing methods (conservés, inchangés) ────────────────────────────────

    connectedCallback() { /* ... */ }
    disconnectedCallback() { /* ... */ }
    renderedCallback() { /* ... */ }

    @api
    get config() { /* ... */ }
    set config(val) { /* ... */ }

    @api
    get selectedRecordId() { /* ... */ }
    set selectedRecordId(val) { /* ... */ }

    @api
    get outputFields() { /* ... */ }
    set outputFields(val) { /* ... */ }

    @api
    get selectedRecord() { /* ... */ }

    @api clearSelection() { /* ... */ }

    @api validate() { /* ... */ }

    @api reportValidity() { /* ... */ }

    // Helpers restants (inchangés)
    _validateConfiguration() { /* ... */ }
    _selectItem(item) { /* ... */ }
    _closeDropdown() { /* ... */ }
    _moveHighlight(direction) { /* ... */ }
    _buildOutputRecordFromFields(fields) { /* ... */ }
    _applyWidth() { /* ... */ }
    _extractFieldValue(fields, fieldPath) { /* ... */ }
    _buildSelectedSubtitle(fields, profile) { /* ... */ }
    _dispatchChange(value) { /* ... */ }
}
