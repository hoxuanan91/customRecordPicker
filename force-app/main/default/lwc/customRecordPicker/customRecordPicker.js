import { LightningElement, api, wire } from "lwc";
import { getRecord } from "lightning/uiRecordApi";
import { FlowAttributeChangeEvent } from "lightning/flowSupport";
import { OmniscriptBaseMixin } from "vlocity_ins/omniscriptBaseMixin";

// ✅ Import Apex method pour SOSL search
import search from "@salesforce/apex/CustomRecordPickerSearchController.search";
import { buildSoslReturningClause } from "./customRecordPickerUtils";

// ─── Constants ───────────────────────────────────────────────────────────────
const FIELD_PATH_REGEX =
    /^[A-Za-z]\w*(__[cCrReE])?(\.[A-Za-z]\w*(__[cCrReE])?)*$/;
const OBJECT_NAME_REGEX = /^[A-Za-z]\w*(__[cCeE])?$/;
const ALLOWED_OPERATORS = new Set([
    "eq",
    "ne",
    "like",
    "gt",
    "gte",
    "lt",
    "lte",
    "in",
    "nin",
]);
const DEBOUNCE_DELAY = 300;
const MAX_RESULTS_CAP = 100;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MIN_SEARCH_LENGTH = 2;
const DEFAULT_PLACEHOLDER = "Rechercher...";
const DEFAULT_ERROR_MESSAGE = "Complétez ce champ.";
const EMPTY_MESSAGE = "Aucun résultat trouvé";

// ─── Validation helpers ──────────────────────────────────────────────────────

function validateFieldPath(value, propName) {
    if (!value) return;
    if (!FIELD_PATH_REGEX.test(value)) {
        throw new Error(
            `customRecordPicker: "${propName}" contains invalid characters: "${value}".`,
        );
    }
}

function validateObjectName(value) {
    if (!value) return;
    if (!OBJECT_NAME_REGEX.test(value)) {
        throw new Error(
            `customRecordPicker: "objectApiName" contains invalid characters: "${value}".`,
        );
    }
}

function validateOperator(op) {
    if (!ALLOWED_OPERATORS.has(op)) {
        throw new Error(
            `customRecordPicker: Unsupported filter operator "${op}".`,
        );
    }
}

function parseLooseJsonString(raw) {
    if (typeof raw !== "string") return raw;
    let normalized = raw.trim();
    // OmniScript wraps the payload with \' ... ' or ' ... ' — strip each end independently.
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

// ─── Component ───────────────────────────────────────────────────────────────

export default class CustomRecordPicker extends OmniscriptBaseMixin(
    LightningElement
) {
    // ─── Public API ──────────────────────────────────────────────────────────

    @api disabled;
    @api width //= "640px";
    @api useOmniscript = false;
    @api useFlow = false;
    @api outputKey = "selectedRecord";

    _config = {
    "label": "Test tous les opérateurs",
    "objectApiName": "Account",
    "titleField": "Name",
    "subtitleFields": [
        { "apiName": "Type", "fieldLabel": "Type" },
        { "apiName": "Industry", "fieldLabel": "Secteur" },
        { "apiName": "AnnualRevenue", "fieldLabel": "CA" }
    ],
    "searchFields": [
        { "apiName": "Name" }
    ],
    "iconName": "standard:account",
    "filter": {
        "criteria": [
            { "fieldPath": "Type", "operator": "eq", "value": "Prospect" },
            { "fieldPath": "Type", "operator": "ne", "value": "Other" },
            { "fieldPath": "Name", "operator": "like", "value": "%a%" },
            { "fieldPath": "CreatedDate", "operator": "gt", "value": { "literal": "LAST_N_YEARS:5" } },
            { "fieldPath": "CreatedDate", "operator": "gte", "value": { "literal": "LAST_N_DAYS:365" } },
            { "fieldPath": "CreatedDate", "operator": "lt", "value": { "literal": "TOMORROW" } },
            { "fieldPath": "CreatedDate", "operator": "lte", "value": { "literal": "TODAY" } },
            { "fieldPath": "Type", "operator": "in", "value": ["Prospect", "Customer"] },
            { "fieldPath": "Type", "operator": "nin", "value": ["Other"] }
        ],
        "filterLogic": "1 OR 2 OR 3 OR 4 OR 5 OR 6 OR 7 OR 8 OR 9"
    },
    "maxResults": 50,
    "minimumSearchLength": 2
}
/*{
   "label":"Tiers payeurs",
   "objectApiName":"Account",
   "titleField":"Name",
   "discriminator":"IsPersonAccount",
   "displayProfiles":{
      "true":{
         "subtitleFields":[
            {
               "apiName":"FirstName",
               "fieldLabel":"Prénom"
            },
            {
               "apiName":"LastName",
               "fieldLabel":"Nom"
            },
            {
               "apiName":"PersonNumber__c",
               "fieldLabel":"N° de personne"
            }
         ]
      },
      "false":{
         "subtitleFields":[
            {
               "apiName":"Name",
               "fieldLabel":"Raison sociale"
            },
            {
               "apiName":"Enseigne__c",
               "fieldLabel":"Enseigne"
            },
            {
               "apiName":"SIRETnumber__c",
               "fieldLabel":"SIRET"
            }
         ]
      }
   },
   "searchFields":[
      {
         "apiName":"SIRETnumber__c"
      },
      {
         "apiName":"Enseigne__c"
      },
      {
         "apiName":"Name"
      }
   ],
   "iconName":"standard:account",
   "filter":{
      "criteria":[
        {
          "apiName": "IsPersonAccount",
          "operator": "eq",
          "value": true
        }
      ],
      "filterLogic":"1"
   },
   "placeholder":"Rechercher tiers payeur",
   "required":true,
   "maxResults":30,
   "minimumSearchLength":2
}*/
    _value;

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
                this._configError =
                    "Configuration invalide: le JSON fourni est incorrect.";
            }
        } else if (val && typeof val === "object") {
            this._config = val;
        } else {
            this._config = {};
        }

        this._validateConfiguration();
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

    @api
    get outputFields() {
        return this._outputFields;
    }
    set outputFields(val) {
        if (Array.isArray(val)) {
            this._outputFields = val;
        } else if (typeof val === "string" && val.trim()) {
            const trimmed = val.trim().replace(/^[\\']|[\\']$/g, "");
            try {
                const parsed = JSON.parse(trimmed);
                this._outputFields = Array.isArray(parsed) ? parsed : [];
            } catch {
                this._outputFields = trimmed.split(",").map((f) => f.trim()).filter(Boolean);
            }
        } else {
            this._outputFields = [];
        }
    }

    @api
    get selectedRecord() {
        return this._selectedRecord;
    }

    @api clearSelection() {
        this._value = undefined;
        this._selectedTitle = undefined;
        this._selectedSubtitle = undefined;
        this._selectedRecord = undefined;
        this._searchTerm = undefined;
        this._results = [];
        this._isDropdownOpen = false;
        this._highlightedIndex = -1;
        this._validationError = undefined;
        this._errorMessage = undefined;
    }

    @api validate() {
        if (this._configError) {
            return { isValid: false, errorMessage: this._configError };
        }

        if (this._cfg.required && !this._value) {
            this._validationError =
                this._cfg.messageWhenValueMissing || DEFAULT_ERROR_MESSAGE;
            return { isValid: false, errorMessage: this._validationError };
        }
        this._validationError = undefined;
        return { isValid: true };
    }

    @api reportValidity() {
        return this.validate().isValid;
    }

    // ─── Config accessors ────────────────────────────────────────────────────

    get _cfg() {
        const c = this._config || {};
        return {
            label: c.label || "Rechercher un enregistrement",
            objectApiName: c.objectApiName,
            titleField: c.titleField || "Name",
            subtitleFields: c.subtitleFields || [],
            searchFields: (Array.isArray(c.searchFields)
                ? c.searchFields
                : []
            ).map((field) =>
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

    get label() {
        return this._cfg.label;
    }
    get objectApiName() {
        return this._cfg.objectApiName;
    }
    get titleField() {
        return this._cfg.titleField;
    }
    get iconName() {
        return this._cfg.iconName;
    }
    get required() {
        return this._cfg.required;
    }
    get placeholder() {
        return this._cfg.placeholder;
    }

    get _subtitleFieldsArray() {
        return this._cfg.subtitleFields;
    }
    get _subtitleApiNames() {
        return this._subtitleFieldsArray.map((f) => f.apiName);
    }
    get _searchFieldsArray() {
        return this._cfg.searchFields;
    }
    get _searchApiNames() {
        return this._searchFieldsArray.map((f) => f.apiName);
    }

    // ─── Display profiles ────────────────────────────────────────────────────

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
        const val = this._readNodeField(node, this._cfg.discriminator);
        return this._getDisplayProfile(val);
    }

    _resolveProfileForFields(fields) {
        if (!this._hasDisplayProfiles) return undefined;
        const val = this._extractFieldValue(fields, this._cfg.discriminator);
        return this._getDisplayProfile(val);
    }

    get _allQueryApiNames() {
        const names = new Set();
        names.add(this.titleField);
        for (const f of this._subtitleApiNames) {
            names.add(f);
        }
        if (this._cfg.discriminator) {
            names.add(this._cfg.discriminator);
        }
        if (this._hasDisplayProfiles) {
            for (const profile of Object.values(this._cfg.displayProfiles)) {
                if (profile.titleField) names.add(profile.titleField);
                if (Array.isArray(profile.subtitleFields)) {
                    for (const f of profile.subtitleFields) {
                        names.add(f.apiName);
                    }
                }
            }
        }
        for (const f of this._outputFields) {
            names.add(f);
        }
        for (const f of this._cfg.outputFields) {
            names.add(f);
        }
        return [...names];
    }

    // ─── Internal state ──────────────────────────────────────────────────────

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

    // ─── Lifecycle ───────────────────────────────────────────────────────────

    connectedCallback() {
        this._validateConfiguration();
        // close dropdown list when clicking outside of the component
        this._clickOutsideHandler = (event) => {
            if (
                !this.template
                    .querySelector(".slds-combobox_container")
                    ?.contains(event.target)
            ) {
                this._closeDropdown();
            }
        };
        // eslint-disable-next-line @lwc/lwc/no-document-query
        document.addEventListener("click", this._clickOutsideHandler);
    }

    disconnectedCallback() {
        // eslint-disable-next-line @lwc/lwc/no-document-query
        document.removeEventListener("click", this._clickOutsideHandler);
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }
    }

    renderedCallback() {
        this._applyWidth();
    }

    // ─── Wire: fetch selected record for pill display ────────────────────────

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
            console.error(
                "customRecordPicker: Error loading selected record",
                error,
            );
        }
    }

    _readNodeField(node, fieldPath) {
        if (!node || !fieldPath) return "";
        const parts = fieldPath.split(".");
        let current = node;
        for (const part of parts) {
            if (current == null || typeof current !== "object") return "";
            current = current[part];
        }
        return current != null ? current : "";
    }

    _extractFieldValue(fields, fieldPath) {
        const parts = fieldPath.split(".");
        let current = fields;
        for (let i = 0; i < parts.length; i++) {
            if (!current) return "";
            const node = current[parts[i]];
            if (!node || node.value === undefined) return "";
            if (i === parts.length - 1) {
                if (node.displayValue != null) return node.displayValue;
                return node.value != null ? node.value : "";
            }
            if (typeof node.value === "object" && node.value !== null) {
                current = node.value.fields || node.value;
            } else {
                return "";
            }
        }
        return "";
    }

    _buildSelectedSubtitle(fields, profile) {
        const subtitleFields =
            profile?.subtitleFields || this._subtitleFieldsArray;
        if (!subtitleFields.length) return undefined;
        const parts = subtitleFields
            .map((field) => {
                const value = this._extractFieldValue(fields, field.apiName);
                return value ? `${field.fieldLabel} : ${value}` : null;
            })
            .filter(Boolean);
        return parts.length ? parts.join(" | ") : undefined;
    }

    _buildFormattedSubtitle(node, profile) {
        const subtitleFields =
            profile?.subtitleFields || this._subtitleFieldsArray;
        if (!subtitleFields.length) return undefined;
        const parts = subtitleFields
            .map((field) => {
                const value = this._readNodeField(node, field.apiName);
                return value ? `${field.fieldLabel} : ${value}` : null;
            })
            .filter(Boolean);
        return parts.length ? parts.join(" | ") : undefined;
    }

    // ─── APEX Search: SOSL with WHERE filters ────────────────────────────────

    /**
     * Execute SOSL search via Apex.
     * Apex builds: FIND {term*} IN ALL FIELDS
     *   RETURNING Object(returnFields WHERE (searchField LIKE '%term%' OR ...) AND (criteria) LIMIT n)
     *
     * @param {string} term - the debounced search term (captured to detect stale results)
     */
    _executeApexSearch(term) {
        const returningClause = buildSoslReturningClause({
            searchTerm: term,
            objectApiName: this._cfg.objectApiName,
            searchApiNames: this._searchApiNames,
            allQueryApiNames: this._allQueryApiNames,
            filter: this._cfg.filter,
            maxResults: this._cfg.maxResults,
        });

        search({ request: { searchTerm: term, returningClause } })
            .then((results) => {
                // Discard if the user has already typed something else
                if (this._searchTerm !== term) return;
                this._isLoading = false;
                this._errorMessage = undefined;
                this._results = results.map((result) => {
                    const node = result.fields;
                    // _resolveProfileForNode reads plain field values (Boolean, String…)
                    // which matches the flat Map returned by Apex getPopulatedFieldsAsMap()
                    const profile = this._resolveProfileForNode(node);
                    const effectiveTitleField = profile?.titleField || this.titleField;
                    return {
                        id: result.id,
                        title: this._readNodeField(node, effectiveTitleField),
                        subtitle: this._buildFormattedSubtitle(node, profile),
                        node,
                    };
                });
            })
            .catch((error) => {
                if (this._searchTerm !== term) return;
                this._isLoading = false;
                this._results = [];
                this._errorMessage =
                    error?.body?.message || error?.message || "Erreur lors de la recherche";
                console.error("customRecordPicker: Apex search error", error);
            });
    }

    // ─── Template getters ────────────────────────────────────────────────────

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

    // ─── Event handlers ──────────────────────────────────────────────────────

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
                this._isLoading = true;
                this._isDropdownOpen = true;
                this._executeApexSearch(term);
            } else {
                this._isLoading = false;
                this._isDropdownOpen = false;
                this._results = [];
            }
        }, DEBOUNCE_DELAY);
    }

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

    // ─── Internal helpers ────────────────────────────────────────────────────

    _validateConfiguration() {
        if (this._configError) return;

        try {
            const rawConfig = this._config || {};
            const hasDiscriminator =
                typeof rawConfig.discriminator === "string" &&
                rawConfig.discriminator.trim().length > 0;
            const hasDisplayProfiles =
                !!rawConfig.displayProfiles &&
                typeof rawConfig.displayProfiles === "object" &&
                Object.keys(rawConfig.displayProfiles).length > 0;

            if (
                typeof rawConfig.objectApiName !== "string" ||
                !rawConfig.objectApiName.trim()
            ) {
                throw new Error(
                    "Configuration invalide: objectApiName est obligatoire.",
                );
            }

            validateObjectName(rawConfig.objectApiName);
            validateFieldPath(this._cfg.titleField, "titleField");

            this._subtitleApiNames.forEach((fieldPath, index) =>
                validateFieldPath(fieldPath, `subtitleFields[${index}].apiName`),
            );

            // searchFields is optional with SOSL (searches all indexed fields).
            // If provided, validate the field paths.
            this._searchFieldsArray.forEach((field, index) => {
                if (!field?.apiName) {
                    throw new Error(
                        `Configuration invalide: searchFields[${index}].apiName est obligatoire.`,
                    );
                }
                validateFieldPath(
                    field.apiName,
                    `searchFields[${index}].apiName`,
                );
            });

            if (hasDiscriminator && !hasDisplayProfiles) {
                throw new Error(
                    "Configuration invalide: displayProfiles est obligatoire quand discriminator est défini.",
                );
            }

            if (!hasDiscriminator && hasDisplayProfiles) {
                throw new Error(
                    "Configuration invalide: discriminator est obligatoire quand displayProfiles est défini.",
                );
            }

            if (rawConfig.discriminator) {
                validateFieldPath(rawConfig.discriminator, "discriminator");
            }
            if (rawConfig.displayProfiles) {
                for (const [key, profile] of Object.entries(
                    rawConfig.displayProfiles,
                )) {
                    if (profile.titleField) {
                        validateFieldPath(
                            profile.titleField,
                            `displayProfiles.${key}.titleField`,
                        );
                    }
                    if (Array.isArray(profile.subtitleFields)) {
                        profile.subtitleFields.forEach((field, idx) => {
                            if (!field?.apiName) {
                                throw new Error(
                                    `Configuration invalide: displayProfiles.${key}.subtitleFields[${idx}].apiName est obligatoire.`,
                                );
                            }
                            validateFieldPath(
                                field.apiName,
                                `displayProfiles.${key}.subtitleFields[${idx}].apiName`,
                            );
                        });
                    }
                }
            }

            this._configError = undefined;
        } catch (error) {
            this._configError =
                error?.message || "Configuration invalide du composant.";
            this._isLoading = false;
            this._isDropdownOpen = false;
            this._results = [];
        }
    }

    _applyWidth() {
        if (!this.template?.host) return;
        if (this.width == null || this.width === "") {
            this.template.host.style.removeProperty("width");
            return;
        }

        const rawWidth = String(this.width).trim();
        const allowedPattern =
            /^(auto|fit-content|max-content|min-content|[0-9]+(?:\.[0-9]+)?(?:px|rem|em|%|vw|vh))$/i;
        if (allowedPattern.test(rawWidth)) {
            this.template.host.style.width = rawWidth;
        } else {
            this.template.host.style.removeProperty("width");
        }        
    }

    _moveHighlight(direction) {
        if (!this._results.length) return;
        let idx = this._highlightedIndex + direction;
        if (idx < 0) idx = this._results.length - 1;
        if (idx >= this._results.length) idx = 0;
        this._highlightedIndex = idx;
        this._scrollHighlightedOptionIntoView();
    }

    _scrollHighlightedOptionIntoView() {
        if (this._highlightedIndex < 0) return;

        requestAnimationFrame(() => {
            const highlightedOption = this.template.querySelector(
                `[data-index="${this._highlightedIndex}"]`,
            );
            highlightedOption?.scrollIntoView({
                block: "nearest",
                inline: "nearest",
            });
        });
    }

    _selectItem(item) {
        this._value = item.id;
        this._selectedTitle = item.title;
        this._selectedSubtitle = item.subtitle;
        this._selectedRecord = this._buildOutputRecordFromNode(item.node);
        this._searchTerm = undefined;
        this._closeDropdown();
        this._validationError = undefined;
        this._errorMessage = undefined;
        this._dispatchChange(item.id);
    }

    _closeDropdown() {
        this._isDropdownOpen = false;
        this._highlightedIndex = -1;
    }

    get _isOmniScriptContext() {
        return this.useOmniscript || !!this.omniJsonData;
    }

    get _isFlowContext() {
        return this.useFlow;
    }

    _buildOutputRecordFromNode(node) {
        if (!node) return null;
        const record = { Id: node.Id };
        for (const fieldPath of this._allQueryApiNames) {
            if (fieldPath === "Id") continue;
            record[fieldPath] = this._readNodeField(node, fieldPath);
        }
        return record;
    }

    _buildOutputRecordFromFields(fields) {
        if (!fields) return null;
        const record = { Id: this._value };
        for (const fieldPath of this._allQueryApiNames) {
            if (fieldPath === "Id") continue;
            record[fieldPath] = this._extractFieldValue(fields, fieldPath);
        }
        return record;
    }

    _dispatchChange(recordId) {
        const record = this._selectedRecord || null;
        // Always dispatch custom event (works in any context: LWC, Flow, OmniScript)
        this.dispatchEvent(
            new CustomEvent("change", {
                detail: { recordId, record },
                bubbles: false,
                composed: false,
            }),
        );

        // Flow context: push value via FlowAttributeChangeEvent
        if (this._isFlowContext) {
            this.dispatchEvent(
                new FlowAttributeChangeEvent("selectedRecordId", recordId),
            );
            this.dispatchEvent(
                new FlowAttributeChangeEvent(
                    "selectedRecord",
                    record ? JSON.stringify(record) : null,
                ),
            );
        }

        // OmniScript context: push value via omniApplyCallResp
        if (this._isOmniScriptContext) {
            this.omniApplyCallResp({
                [`${this.outputKey}Id`]: recordId,
                [this.outputKey]: record,
            });
        }
    }
}
