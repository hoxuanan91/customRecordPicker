import { LightningElement, api, wire } from "lwc";
import { getRecord } from "lightning/uiRecordApi";
import { FlowAttributeChangeEvent } from "lightning/flowSupport";
import { OmniscriptBaseMixin } from "vlocity_ins/omniscriptBaseMixin";

// ✅ Import Apex method pour SOSL search
import search from "@salesforce/apex/CustomRecordPickerSearchController.search";

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
const SALESFORCE_ID_REGEX = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
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

// Escape SOSL reserved characters (keeps * so callers can append wildcard)
function sanitizeSoslTerm(term) {
    return term.replace(/[?&|!{}[\]()^~:\\"'+-]/g, "\\$&");
}

// Escape SQL LIKE special characters
function sanitizeLikeTerm(term) {
    return term.replace(/[%_]/g, "\\$&");
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

// ─── Filter logic parser (recursive descent) ────────────────────────────────

function tokenize(filterLogic) {
    const tokens = [];
    let i = 0;
    const str = filterLogic.toUpperCase().trim();
    while (i < str.length) {
        if (str[i] === " " || str[i] === "\t") {
            i++;
            continue;
        }
        if (str[i] === "(") {
            tokens.push({ type: "LPAREN" });
            i++;
            continue;
        }
        if (str[i] === ")") {
            tokens.push({ type: "RPAREN" });
            i++;
            continue;
        }
        if (
            str.startsWith("AND", i) &&
            (i + 3 >= str.length || /\W/.test(str[i + 3]))
        ) {
            tokens.push({ type: "AND" });
            i += 3;
            continue;
        }
        if (
            str.startsWith("OR", i) &&
            (i + 2 >= str.length || /\W/.test(str[i + 2]))
        ) {
            tokens.push({ type: "OR" });
            i += 2;
            continue;
        }
        if (
            str.startsWith("NOT", i) &&
            (i + 3 >= str.length || /\W/.test(str[i + 3]))
        ) {
            tokens.push({ type: "NOT" });
            i += 3;
            continue;
        }
        const numMatch = str.slice(i).match(/^\d+/);
        if (numMatch) {
            tokens.push({ type: "NUMBER", value: parseInt(numMatch[0], 10) });
            i += numMatch[0].length;
            continue;
        }
        throw new Error(
            `customRecordPicker: Unexpected character "${str[i]}" in filterLogic at position ${i}`,
        );
    }
    return tokens;
}

function parseFilterLogic(filterLogic, criteriaMap) {
    const tokens = tokenize(filterLogic);
    let pos = 0;
    function peek() {
        return tokens[pos];
    }
    function consume(type) {
        const t = tokens[pos];
        if (!t || t.type !== type) {
            throw new Error(
                `customRecordPicker: Expected ${type} at position ${pos} in filterLogic, got ${t?.type || "EOF"}`,
            );
        }
        pos++;
        return t;
    }
    function parseExpr() {
        let left = parseTerm();
        while (peek()?.type === "OR") {
            consume("OR");
            left = { or: [left, parseTerm()] };
        }
        return left;
    }
    function parseTerm() {
        let left = parseFactor();
        while (peek()?.type === "AND") {
            consume("AND");
            left = { and: [left, parseFactor()] };
        }
        return left;
    }
    function parseFactor() {
        if (peek()?.type === "NOT") {
            consume("NOT");
            return { not: parseFactor() };
        }
        if (peek()?.type === "LPAREN") {
            consume("LPAREN");
            const expr = parseExpr();
            consume("RPAREN");
            return expr;
        }
        const token = consume("NUMBER");
        const criterion = criteriaMap.get(token.value);
        if (!criterion) {
            throw new Error(
                `customRecordPicker: filterLogic references criterion ${token.value} which does not exist`,
            );
        }
        return criterion;
    }
    const result = parseExpr();
    if (pos < tokens.length) {
        throw new Error(
            `customRecordPicker: Unexpected token at position ${pos}`,
        );
    }
    return result;
}

function flattenLogic(node) {
    if (!node) return node;
    if (node.and) {
        const flat = [];
        for (const child of node.and) {
            const f = flattenLogic(child);
            if (f.and) {
                flat.push(...f.and);
            } else {
                flat.push(f);
            }
        }
        return { and: flat };
    }
    if (node.or) {
        const flat = [];
        for (const child of node.or) {
            const f = flattenLogic(child);
            if (f.or) {
                flat.push(...f.or);
            } else {
                flat.push(f);
            }
        }
        return { or: flat };
    }
    if (node.not) {
        return { not: flattenLogic(node.not) };
    }
    return node;
}

// ─── GraphQL helpers ─────────────────────────────────────────────────────────

function fieldToGraphQL(fieldPath) {
    const parts = fieldPath.split(".");
    let result = "";
    for (let i = 0; i < parts.length - 1; i++) {
        result += `${parts[i]} { `;
    }
    const leaf = parts[parts.length - 1];
    result += leaf === "Id" ? "Id" : `${leaf} { value displayValue }`;
    for (let i = 0; i < parts.length - 1; i++) {
        result += " }";
    }
    return result;
}

function fieldPathToWhereNesting(fieldPath) {
    const parts = fieldPath.split(".");
    if (parts.length === 1) return { prefix: parts[0], suffix: "" };
    let prefix = "",
        suffix = "";
    for (let i = 0; i < parts.length - 1; i++) {
        prefix += `${parts[i]}: { `;
        suffix += " }";
    }
    prefix += parts[parts.length - 1];
    return { prefix, suffix };
}

function serializeWhereClause(node) {
    if (!node) return "";
    if (node.and)
        return `{ and: [${node.and.map(serializeWhereClause).join(", ")}] }`;
    if (node.or)
        return `{ or: [${node.or.map(serializeWhereClause).join(", ")}] }`;
    if (node.not) return `{ not: ${serializeWhereClause(node.not)} }`;
    if (node._raw) return node._raw;
    return "";
}

/**
 * Check if a filter value is a date/datetime input object.
 * Supports:
 *   { literal: "TODAY" }           → simple DATE_LITERAL enum
 *   { literal: "LAST_N_DAYS:30" }  → auto-converted to range
 *   { range: { last_n_days: 30 } } → explicit DateRange
 */
function isDateValue(value) {
    if (value === null || typeof value !== "object") return false;
    return (
        typeof value.literal === "string" ||
        (typeof value.range === "object" && value.range !== null)
    );
}

/**
 * Serialize a date value object into inline GraphQL syntax.
 *
 * Examples:
 *   { literal: "TODAY" }            → { literal: TODAY }
 *   { literal: "LAST_N_DAYS:30" }   → { range: { last_n_days: 30 } }
 *   { range: { last_n_days: 30 } }  → { range: { last_n_days: 30 } }
 */
function serializeDateValue(value) {
    if (typeof value.literal === "string") {
        const rangeMatch = value.literal.match(/^([A-Z_]+):(\d+)$/);
        if (rangeMatch) {
            const rangeName = rangeMatch[1].toLowerCase();
            const rangeVal = parseInt(rangeMatch[2], 10);
            return `{ range: { ${rangeName}: ${rangeVal} } }`;
        }
        return `{ literal: ${value.literal} }`;
    }
    if (value.range && typeof value.range === "object") {
        const entries = Object.entries(value.range);
        if (entries.length === 1) {
            const [key, val] = entries[0];
            return `{ range: { ${key}: ${val} } }`;
        }
    }
    throw new Error(
        `customRecordPicker: Invalid date value: ${JSON.stringify(value)}`,
    );
}

/**
 * Infer the GraphQL variable type from a filter criterion value.
 */
function inferGraphQLType(value) {
    if (value === null) return "String";
    if (isDateValue(value)) return "DateTime";
    if (typeof value === "string" && SALESFORCE_ID_REGEX.test(value))
        return "ID";
    if (typeof value === "number")
        return Number.isInteger(value) ? "Int" : "Float";
    if (typeof value === "boolean") return "Boolean";
    return "String";
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

    _config = /*{
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
            { "fieldPath": "Type", "operator": "eq", "value": "Prospect", "dataType": "Picklist" },
            { "fieldPath": "Type", "operator": "ne", "value": "Other", "dataType": "Picklist" },
            { "fieldPath": "Name", "operator": "like", "value": "%a%" },
            { "fieldPath": "CreatedDate", "operator": "gt", "value": { "literal": "LAST_N_YEARS:5" }, "dataType": "DateTime" },
            { "fieldPath": "CreatedDate", "operator": "gte", "value": { "literal": "LAST_N_DAYS:365" }, "dataType": "DateTime" },
            { "fieldPath": "CreatedDate", "operator": "lt", "value": { "literal": "TOMORROW" }, "dataType": "DateTime" },
            { "fieldPath": "CreatedDate", "operator": "lte", "value": { "literal": "TODAY" }, "dataType": "DateTime" },
            { "fieldPath": "Type", "operator": "in", "value": ["Prospect", "Customer"], "dataType": "[Picklist]" },
            { "fieldPath": "Type", "operator": "nin", "value": ["Other"], "dataType": "[Picklist]" }
        ],
        "filterLogic": "1 OR 2 OR 3 OR 4 OR 5 OR 6 OR 7 OR 8 OR 9"
    },
    "maxResults": 50,
    "minimumSearchLength": 2
}*/
{
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
}
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

    // ─── APEX Search: SOSL with WHERE filters ────────────────────────────────

    /**
     * Execute SOSL search via Apex
     * Apex builds: FIND 'term*' RETURNING Object(fields 
     *   WHERE (searchField LIKE '%term%' ...) AND (criteria filters)
     * )
     */
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
            // ✅ Build the request for Apex
            const request = {
                searchTerm: this._searchTerm,
                objectApiName: this._cfg.objectApiName,
                searchFields: this._searchApiNames,        // ["Name", "SIRETnumber__c", "Enseigne__c"]
                maxResults: this._cfg.maxResults,
                criteria: this._cfg.filter?.criteria || [],
                filterLogic: this._cfg.filter?.filterLogic
            };

            console.log("📤 [SOSL Apex] Search request:", {
                searchTerm: request.searchTerm,
                object: request.objectApiName,
                searchFields: request.searchFields,
                criteria: request.criteria
            });

            // ✅ Call Apex method (await waits for response)
            const results = await search({ request });

            console.log("📥 [SOSL Apex] Results:", results.length + " records");

            this._errorMessage = undefined;

            // ✅ Transform Apex results to template format
            this._results = results.map((result) => {
                const profile = this._resolveProfileForFields(result.fields);
                const effectiveTitleField = profile?.titleField || this.titleField;
                
                return {
                    id: result.id,
                    title: result.fields[effectiveTitleField] || result.fields.Name || "",
                    subtitle: this._buildApexSubtitle(result.fields, profile),
                    node: result.fields,
                };
            });

        } catch (error) {
            console.error("❌ [SOSL Apex] Error:", error);
            this._errorMessage = error?.body?.message || error.message || "Erreur lors de la recherche";
            this._results = [];

        } finally {
            this._isLoading = false;
        }
    }

    /**
     * Build subtitle from Apex result fields
     */
    _buildApexSubtitle(fields, profile) {
        const subtitleFields = profile?.subtitleFields || this._subtitleFieldsArray;
        if (!subtitleFields.length) return undefined;

        const parts = subtitleFields
            .map((field) => {
                const value = fields[field.apiName];
                return value ? `${field.fieldLabel} : ${value}` : null;
            })
            .filter(Boolean);

        return parts.length ? parts.join(" | ") : undefined;
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
                // ✅ Appeler la recherche Apex au lieu de dépendre de @wire
                this._executeApexSearch();
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
