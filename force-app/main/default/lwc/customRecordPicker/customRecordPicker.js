import { LightningElement, api, wire } from "lwc";
import { gql, graphql } from "lightning/uiGraphQLApi";
import { getRecord } from "lightning/uiRecordApi";
import { FlowAttributeChangeEvent } from "lightning/flowSupport";
import {
    validateFieldPath,
    validateObjectName,
    validateOperator,
    sanitizeSearchTerm,
    parseFilterLogic,
    flattenLogic,
    fieldToGraphQL,
    fieldPathToWhereNesting,
    serializeWhereClause,
    isDateLiteral,
    inferGraphQLType,
} from "./customRecordPickerUtils";

// ─── Constants ────────────────────────────────────────────────────────────────
const WIDTH_PATTERN =
    /^(auto|fit-content|max-content|min-content|[0-9]+(?:\.[0-9]+)?(?:px|rem|em|%|vw|vh))$/i;
const DEBOUNCE_DELAY = 300;
const MAX_RESULTS_CAP = 100;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MIN_SEARCH_LENGTH = 2;
const DEFAULT_PLACEHOLDER = "Rechercher...";
const DEFAULT_ERROR_MESSAGE = "Complétez ce champ.";
const EMPTY_MESSAGE = "Aucun résultat trouvé";


// ─── Component ────────────────────────────────────────────────────────────────

export default class CustomRecordPicker extends LightningElement {
    // ─── Public API ───────────────────────────────────────────────────────────

    @api disabled;
    @api width = "640px";
    @api useFlow = false;

    _config;
    _value;
    _cfgCache;
    _filterDataCache = { term: undefined, data: undefined };

    @api
    get config() {
        return this._config;
    }
    set config(val) {
        this._configError = undefined;
        this._cfgCache = undefined;
        if (typeof val === "string" && val) {
            try {
                this._config = JSON.parse(val.trim().replace(/^[\\']+|[\\']+$/g, ""));
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
        }
    }

    @api clearSelection() {
        this._value = undefined;
        this._selectedTitle = undefined;
        this._selectedSubtitle = undefined;
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

    // ─── Config accessor (cached per config change) ───────────────────────────

    get _cfg() {
        if (!this._cfgCache) {
            const c = this._config || {};
            this._cfgCache = {
                label: c.label || "Rechercher un enregistrement",
                objectApiName: c.objectApiName,
                titleField: c.titleField || "Name",
                subtitleFields: c.subtitleFields || [],
                searchFields: (Array.isArray(c.searchFields) ? c.searchFields : []).map(
                    (f) =>
                        typeof f === "string"
                            ? { apiName: f, dataType: "String" }
                            : { ...f, dataType: f.dataType || "String" },
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
            };
        }
        return this._cfgCache;
    }

    get label()         { return this._cfg.label; }
    get objectApiName() { return this._cfg.objectApiName; }
    get titleField()    { return this._cfg.titleField; }
    get iconName()      { return this._cfg.iconName; }
    get required()      { return this._cfg.required; }
    get placeholder()   { return this._cfg.placeholder; }

    // ─── Display profiles ─────────────────────────────────────────────────────

    get _hasDisplayProfiles() {
        const { discriminator, displayProfiles } = this._cfg;
        return (
            !!discriminator &&
            !!displayProfiles &&
            Object.keys(displayProfiles).length > 0
        );
    }

    _getDisplayProfile(discriminatorValue) {
        if (!this._hasDisplayProfiles) return undefined;
        return this._cfg.displayProfiles[String(discriminatorValue ?? "")] || undefined;
    }

    _resolveProfileForNode(node) {
        if (!this._hasDisplayProfiles) return undefined;
        return this._getDisplayProfile(this._readNodeField(node, this._cfg.discriminator));
    }

    _resolveProfileForFields(fields) {
        if (!this._hasDisplayProfiles) return undefined;
        return this._getDisplayProfile(this._extractFieldValue(fields, this._cfg.discriminator));
    }

    get _allQueryApiNames() {
        const names = new Set([this.titleField]);
        this._cfg.subtitleFields.forEach((f) => names.add(f.apiName));
        if (this._cfg.discriminator) names.add(this._cfg.discriminator);
        if (this._hasDisplayProfiles) {
            for (const profile of Object.values(this._cfg.displayProfiles)) {
                if (profile.titleField) names.add(profile.titleField);
                if (Array.isArray(profile.subtitleFields)) {
                    profile.subtitleFields.forEach((f) => names.add(f.apiName));
                }
            }
        }
        return [...names];
    }

    // ─── Internal state ───────────────────────────────────────────────────────

    _selectedTitle;
    _selectedSubtitle;
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

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    connectedCallback() {
        this._validateConfiguration();
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
        clearTimeout(this._debounceTimer);
    }

    renderedCallback() {
        this._applyWidth();
    }

    // ─── Wire: fetch selected record for pill display ──────────────────────────

    get _selectedRecordFields() {
        if (!this._value || !this.objectApiName || !this.titleField)
            return undefined;
        return this._allQueryApiNames.map((f) => `${this.objectApiName}.${f}`);
    }

    @wire(getRecord, { recordId: "$_value", fields: "$_selectedRecordFields" })
    _wiredSelectedRecord({ data, error }) {
        if (data) {
            const profile = this._resolveProfileForFields(data.fields);
            this._selectedTitle = this._extractFieldValue(
                data.fields,
                profile?.titleField || this.titleField,
            );
            this._selectedSubtitle = this._buildSubtitle(
                profile?.subtitleFields || this._cfg.subtitleFields,
                (apiName) => this._extractFieldValue(data.fields, apiName),
            );
        }
        if (error) {
            console.error("customRecordPicker: Error loading selected record", error);
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
                return node.displayValue != null ? node.displayValue : (node.value ?? "");
            }
            current =
                typeof node.value === "object" && node.value !== null
                    ? node.value.fields || node.value
                    : null;
        }
        return "";
    }

    // ─── Wire: GraphQL search ──────────────────────────────────────────────────

    @wire(graphql, { query: "$_graphqlQuery", variables: "$_graphqlVariables" })
    _wiredSearchResults({ data, errors }) {
        this._isLoading = false;
        if (data) {
            this._errorMessage = undefined;
            const edges = data.uiapi?.query?.[this.objectApiName]?.edges || [];
            this._results = edges.map((edge) => {
                const profile = this._resolveProfileForNode(edge.node);
                return {
                    id: edge.node.Id,
                    title: this._readNodeField(
                        edge.node,
                        profile?.titleField || this.titleField,
                    ),
                    subtitle: this._buildSubtitle(
                        profile?.subtitleFields || this._cfg.subtitleFields,
                        (apiName) => this._readNodeField(edge.node, apiName),
                    ),
                };
            });
        }
        if (errors) {
            console.error("customRecordPicker: GraphQL error", errors);
            this._errorMessage =
                errors.map((e) => e.message).join(". ") ||
                "Erreur lors de la recherche";
            this._results = [];
        }
    }

    _readNodeField(node, fieldPath) {
        const parts = fieldPath.split(".");
        let current = node;
        for (const part of parts) {
            if (!current) return "";
            current = current[part];
        }
        if (current == null) return "";
        if (typeof current === "object") {
            return current.displayValue != null
                ? current.displayValue
                : (current.value ?? "");
        }
        return current;
    }

    // ─── Subtitle builder (shared between search results and selected record) ──

    _buildSubtitle(subtitleFields, readFn) {
        if (!subtitleFields?.length) return undefined;
        const parts = subtitleFields
            .map((f) => {
                const v = readFn(f.apiName);
                return v ? `${f.fieldLabel} : ${v}` : null;
            })
            .filter(Boolean);
        return parts.length ? parts.join(" | ") : undefined;
    }

    // ─── Filter → GraphQL where clause (cached per search term) ───────────────

    get _filterData() {
        const term = this._searchTerm;
        if (this._filterDataCache.term !== term) {
            this._filterDataCache = { term, data: this._computeFilterData(term) };
        }
        return this._filterDataCache.data;
    }

    _computeFilterData(term) {
        const filterVariables = {};
        const variableDeclarations = [];
        const conditions = [];

        // Search condition — OR across searchFields
        if (term && term.length >= this._cfg.minimumSearchLength) {
            const searchParts = this._cfg.searchFields.map((field, index) => {
                const varName = `searchTerm${index}`;
                const isPicklist = field.dataType === "Picklist";
                variableDeclarations.push(`$${varName}: ${field.dataType || "String"}`);
                filterVariables[varName] = isPicklist
                    ? term
                    : `%${sanitizeSearchTerm(term)}%`;
                const { prefix, suffix } = fieldPathToWhereNesting(field.apiName);
                return `{ ${prefix}: { ${isPicklist ? "eq" : "like"}: $${varName} }${suffix} }`;
            });
            conditions.push(
                searchParts.length === 1
                    ? searchParts[0]
                    : `{ or: [${searchParts.join(", ")}] }`,
            );
        }

        // Filter criteria
        const filter = this._cfg.filter;
        if (filter?.criteria?.length) {
            const criteriaMap = new Map();
            filter.criteria.forEach((criterion, index) => {
                validateFieldPath(
                    criterion.fieldPath,
                    `filter.criteria[${index}].fieldPath`,
                );
                validateOperator(criterion.operator);
                const varName = `filterVal${index}`;
                const { prefix, suffix } = fieldPathToWhereNesting(
                    criterion.fieldPath,
                );
                if (isDateLiteral(criterion.value)) {
                    criteriaMap.set(index + 1, {
                        _raw: `{ ${prefix}: { ${criterion.operator}: { literal: ${criterion.value.literal} } }${suffix} }`,
                    });
                } else {
                    criteriaMap.set(index + 1, {
                        _raw: `{ ${prefix}: { ${criterion.operator}: $${varName} }${suffix} }`,
                    });
                    variableDeclarations.push(
                        `$${varName}: ${inferGraphQLType(criterion.value)}`,
                    );
                    filterVariables[varName] = criterion.value;
                }
            });

            let filterTree;
            if (filter.filterLogic) {
                filterTree = flattenLogic(
                    parseFilterLogic(filter.filterLogic, criteriaMap),
                );
            } else {
                filterTree =
                    criteriaMap.size === 1
                        ? criteriaMap.get(1)
                        : { and: [...criteriaMap.values()] };
            }
            conditions.push(serializeWhereClause(filterTree));
        }

        let whereClause = "";
        if (conditions.length > 1) {
            whereClause = `where: { and: [${conditions.join(", ")}] }`;
        } else if (conditions.length === 1) {
            whereClause = `where: ${conditions[0]}`;
        }

        return { whereClause, variableDeclarations, filterVariables };
    }

    // ─── Dynamic GraphQL query ─────────────────────────────────────────────────

    get _graphqlQuery() {
        if (this._configError) return undefined;
        if (!this.objectApiName || !this.titleField) return undefined;
        if (
            !this._searchTerm ||
            this._searchTerm.length < this._cfg.minimumSearchLength
        )
            return undefined;

        const { whereClause, variableDeclarations } = this._filterData;
        const allFieldsGql = this._allQueryApiNames
            .map((f) => fieldToGraphQL(f))
            .join("\n                                    ");
        const orderByLeaf = this.titleField.split(".").pop();
        const varDecl =
            variableDeclarations.length > 0
                ? `(${variableDeclarations.join(", ")})`
                : "";

        return gql`
            query SearchRecords${varDecl} {
                uiapi {
                    query {
                        ${this.objectApiName}(
                            ${whereClause}
                            first: ${this._cfg.maxResults}
                            orderBy: { ${orderByLeaf}: { order: ASC } }
                        ) {
                            edges {
                                node {
                                    Id
                                    ${allFieldsGql}
                                }
                            }
                        }
                    }
                }
            }
        `;
    }

    get _graphqlVariables() {
        if (this._configError) return undefined;
        if (
            !this._searchTerm ||
            this._searchTerm.length < this._cfg.minimumSearchLength
        )
            return undefined;
        return this._filterData.filterVariables;
    }

    // ─── Template getters ──────────────────────────────────────────────────────

    @api get isSelected() {
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
            !!this._searchTerm &&
            (this.hasResults || this._isLoading || this._showEmptyMessage)
        );
    }

    get _showEmptyMessage() {
        return (
            !this._isLoading &&
            !this.hasResults &&
            !!this._searchTerm &&
            this._searchTerm.length >= this._cfg.minimumSearchLength
        );
    }

    @api get hasError() {
        return (
            !!this._configError ||
            !!this._validationError ||
            !!this._errorMessage
        );
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
            optionClass: `slds-media slds-listbox__option slds-listbox__option_entity slds-listbox__option_has-meta${
                index === this._highlightedIndex ? " slds-has-focus" : ""
            }`,
            ariaSelected: index === this._highlightedIndex ? "true" : "false",
        }));
    }

    // ─── Event handlers ───────────────────────────────────────────────────────

    handleInput(event) {
        const term = event.detail.value;
        this._validationError = undefined;
        this._errorMessage = undefined;
        clearTimeout(this._debounceTimer);
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
            } else {
                this._isLoading = false;
                this._isDropdownOpen = false;
                this._results = [];
            }
        }, DEBOUNCE_DELAY);
    }

    handleFocus() {
        if (
            !this.isSelected &&
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
        if (item) this._selectItem(item);
    }

    handleClear() {
        if (this.disabled) return;
        this.clearSelection();
        this._dispatchChange(null);
    }

    // ─── Internal helpers ──────────────────────────────────────────────────────

    _validateConfiguration() {
        if (this._configError) return;
        try {
            const c = this._config || {};

            if (typeof c.objectApiName !== "string" || !c.objectApiName.trim()) {
                throw new Error(
                    "Configuration invalide: objectApiName est obligatoire.",
                );
            }
            if (!Array.isArray(c.searchFields) || c.searchFields.length === 0) {
                throw new Error(
                    "Configuration invalide: searchFields est obligatoire.",
                );
            }

            validateObjectName(c.objectApiName);
            validateFieldPath(this._cfg.titleField, "titleField");

            this._cfg.subtitleFields.forEach((f, i) =>
                validateFieldPath(f.apiName, `subtitleFields[${i}].apiName`),
            );
            this._cfg.searchFields.forEach((f, i) => {
                if (!f?.apiName) {
                    throw new Error(
                        `Configuration invalide: searchFields[${i}].apiName est obligatoire.`,
                    );
                }
                validateFieldPath(f.apiName, `searchFields[${i}].apiName`);
            });

            const hasDiscriminator =
                typeof c.discriminator === "string" &&
                c.discriminator.trim().length > 0;
            const hasDisplayProfiles =
                !!c.displayProfiles &&
                typeof c.displayProfiles === "object" &&
                Object.keys(c.displayProfiles).length > 0;

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

            if (c.discriminator) {
                validateFieldPath(c.discriminator, "discriminator");
            }
            if (c.displayProfiles) {
                for (const [key, profile] of Object.entries(c.displayProfiles)) {
                    if (profile.titleField) {
                        validateFieldPath(
                            profile.titleField,
                            `displayProfiles.${key}.titleField`,
                        );
                    }
                    if (Array.isArray(profile.subtitleFields)) {
                        profile.subtitleFields.forEach((f, idx) => {
                            if (!f?.apiName) {
                                throw new Error(
                                    `Configuration invalide: displayProfiles.${key}.subtitleFields[${idx}].apiName est obligatoire.`,
                                );
                            }
                            validateFieldPath(
                                f.apiName,
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
        const raw = String(this.width).trim();
        if (WIDTH_PATTERN.test(raw)) {
            this.template.host.style.width = raw;
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
            this.template
                .querySelector(`[data-index="${this._highlightedIndex}"]`)
                ?.scrollIntoView({ block: "nearest", inline: "nearest" });
        });
    }

    _selectItem(item) {
        this._value = item.id;
        this._selectedTitle = item.title;
        this._selectedSubtitle = item.subtitle;
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

    _dispatchChange(recordId) {
        this.dispatchEvent(
            new CustomEvent("change", {
                detail: { recordId },
                bubbles: false,
                composed: false,
            }),
        );
        if (this.useFlow) {
            this.dispatchEvent(
                new FlowAttributeChangeEvent("selectedRecordId", recordId),
            );
        }
    }
}
