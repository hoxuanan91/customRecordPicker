// ─── Regex constants ──────────────────────────────────────────────────────────
export const FIELD_PATH_REGEX =
    /^[A-Za-z]\w*(__[cCrReE])?(\.[A-Za-z]\w*(__[cCrReE])?)*$/;
export const OBJECT_NAME_REGEX = /^[A-Za-z]\w*(__[cCeE])?$/;
export const ALLOWED_OPERATORS = new Set([
    "eq", "ne", "like", "gt", "gte", "lt", "lte", "in", "nin",
]);
const SALESFORCE_ID_REGEX = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

// ─── Validation helpers ───────────────────────────────────────────────────────

export function validateFieldPath(value, propName) {
    if (!value) return;
    if (!FIELD_PATH_REGEX.test(value)) {
        throw new Error(
            `customRecordPicker: "${propName}" contains invalid characters: "${value}".`,
        );
    }
}

export function validateObjectName(value) {
    if (!value) return;
    if (!OBJECT_NAME_REGEX.test(value)) {
        throw new Error(
            `customRecordPicker: "objectApiName" contains invalid characters: "${value}".`,
        );
    }
}

export function validateOperator(op) {
    if (!ALLOWED_OPERATORS.has(op)) {
        throw new Error(
            `customRecordPicker: Unsupported filter operator "${op}".`,
        );
    }
}

export function sanitizeSearchTerm(term) {
    return term.replace(/[%_]/g, "\\$&");
}

// ─── Filter logic parser (recursive descent) ──────────────────────────────────

export function tokenize(filterLogic) {
    const tokens = [];
    let i = 0;
    const str = filterLogic.toUpperCase().trim();
    while (i < str.length) {
        if (/\s/.test(str[i])) { i++; continue; }
        if (str[i] === "(") { tokens.push({ type: "LPAREN" }); i++; continue; }
        if (str[i] === ")") { tokens.push({ type: "RPAREN" }); i++; continue; }
        if (str.startsWith("AND", i) && (i + 3 >= str.length || /\W/.test(str[i + 3]))) {
            tokens.push({ type: "AND" }); i += 3; continue;
        }
        if (str.startsWith("OR", i) && (i + 2 >= str.length || /\W/.test(str[i + 2]))) {
            tokens.push({ type: "OR" }); i += 2; continue;
        }
        if (str.startsWith("NOT", i) && (i + 3 >= str.length || /\W/.test(str[i + 3]))) {
            tokens.push({ type: "NOT" }); i += 3; continue;
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

export function parseFilterLogic(filterLogic, criteriaMap) {
    const tokens = tokenize(filterLogic);
    let pos = 0;
    const peek = () => tokens[pos];
    const consume = (type) => {
        const t = tokens[pos];
        if (!t || t.type !== type) {
            throw new Error(
                `customRecordPicker: Expected ${type} at position ${pos}, got ${t?.type || "EOF"}`,
            );
        }
        return tokens[pos++];
    };
    const parseFactor = () => {
        if (peek()?.type === "NOT") { consume("NOT"); return { not: parseFactor() }; }
        if (peek()?.type === "LPAREN") {
            consume("LPAREN");
            const expr = parseExpr(); // eslint-disable-line no-use-before-define
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
    };
    const parseTerm = () => {
        let left = parseFactor();
        while (peek()?.type === "AND") { consume("AND"); left = { and: [left, parseFactor()] }; }
        return left;
    };
    const parseExpr = () => {
        let left = parseTerm();
        while (peek()?.type === "OR") { consume("OR"); left = { or: [left, parseTerm()] }; }
        return left;
    };
    const result = parseExpr();
    if (pos < tokens.length) {
        throw new Error(`customRecordPicker: Unexpected token at position ${pos}`);
    }
    return result;
}

export function flattenLogic(node) {
    if (!node) return node;
    if (node.and) {
        const flat = [];
        for (const child of node.and) {
            const f = flattenLogic(child);
            flat.push(...(f.and ? f.and : [f]));
        }
        return { and: flat };
    }
    if (node.or) {
        const flat = [];
        for (const child of node.or) {
            const f = flattenLogic(child);
            flat.push(...(f.or ? f.or : [f]));
        }
        return { or: flat };
    }
    if (node.not) return { not: flattenLogic(node.not) };
    return node;
}

// ─── GraphQL helpers ──────────────────────────────────────────────────────────

export function fieldToGraphQL(fieldPath) {
    const parts = fieldPath.split(".");
    const open = parts.slice(0, -1).map((p) => `${p} { `).join("");
    const close = " }".repeat(parts.length - 1);
    const leaf = parts[parts.length - 1];
    return `${open}${leaf === "Id" ? "Id" : `${leaf} { value displayValue }`}${close}`;
}

export function fieldPathToWhereNesting(fieldPath) {
    const parts = fieldPath.split(".");
    if (parts.length === 1) return { prefix: parts[0], suffix: "" };
    const prefix =
        parts.slice(0, -1).map((p) => `${p}: { `).join("") +
        parts[parts.length - 1];
    return { prefix, suffix: " }".repeat(parts.length - 1) };
}

export function serializeWhereClause(node) {
    if (!node) return "";
    if (node.and) return `{ and: [${node.and.map(serializeWhereClause).join(", ")}] }`;
    if (node.or)  return `{ or: [${node.or.map(serializeWhereClause).join(", ")}] }`;
    if (node.not) return `{ not: ${serializeWhereClause(node.not)} }`;
    if (node._raw) return node._raw;
    return "";
}

export function isDateLiteral(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        typeof value.literal === "string"
    );
}

export function inferGraphQLType(value) {
    if (value === null) return "String";
    if (isDateLiteral(value)) return "Date";
    if (typeof value === "string" && SALESFORCE_ID_REGEX.test(value)) return "ID";
    if (typeof value === "number") return Number.isInteger(value) ? "Int" : "Float";
    if (typeof value === "boolean") return "Boolean";
    return "String";
}

// ─── SOSL query building ──────────────────────────────────────────────────────

export function sanitizeSoslFindTerm(term) {
    return term.replace(/[?&|!{}[\]()^~:\\"'+-]/g, "\\$&");
}

export function formatSoslVal(value) {
    if (value === null || value === undefined) return "null";
    if (isDateLiteral(value)) return value.literal;
    if (typeof value === "string") {
        return "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
    }
    return String(value);
}

export function buildSoslCondition(criterion) {
    const { fieldPath, operator, value } = criterion;
    if (operator === "in" || operator === "nin") {
        const arr = Array.isArray(value) ? value : (value != null ? [value] : [null]);
        return `${fieldPath} ${operator === "in" ? "IN" : "NOT IN"} (${arr.map(formatSoslVal).join(", ")})`;
    }
    const opMap = { eq: "=", ne: "!=", like: "LIKE", gt: ">", gte: ">=", lt: "<", lte: "<=" };
    const op = opMap[operator];
    if (!op) throw new Error(`customRecordPicker: Unsupported operator "${operator}"`);
    return `${fieldPath} ${op} ${formatSoslVal(value)}`;
}

export function applySoslFilterLogic(logic, condMap) {
    let result = "";
    let i = 0;
    const s = logic.toUpperCase().trim();
    while (i < s.length) {
        const ch = s[i];
        if (/\s/.test(ch)) { i++; continue; }
        if (ch === "(" || ch === ")") { result += ch; i++; continue; }
        if (/\d/.test(ch)) {
            let j = i + 1;
            while (j < s.length && /\d/.test(s[j])) j++;
            const idx = parseInt(s.slice(i, j), 10);
            result += condMap.has(idx) ? condMap.get(idx) : String(idx);
            i = j;
            continue;
        }
        if (s.startsWith("AND", i) && (i + 3 >= s.length || /\W/.test(s[i + 3]))) {
            result += " AND "; i += 3; continue;
        }
        if (s.startsWith("OR", i) && (i + 2 >= s.length || /\W/.test(s[i + 2]))) {
            result += " OR "; i += 2; continue;
        }
        if (s.startsWith("NOT", i) && (i + 3 >= s.length || /\W/.test(s[i + 3]))) {
            result += " NOT "; i += 3; continue;
        }
        i++;
    }
    return result.trim().replace(/\s{2,}/g, " ");
}

/**
 * Builds a complete SOSL query string from config parameters.
 *
 * @param {string} searchTerm - Raw user input (not yet sanitized)
 * @param {string} objectApiName - Salesforce object API name
 * @param {string[]} searchApiNames - Field API names to apply LIKE filter on
 * @param {string[]} allQueryApiNames - All fields needed in the result (title, subtitle, etc.)
 * @param {{ criteria: Array, filterLogic: string }} filter - Filter config
 * @param {number} maxResults - Max number of results (capped at 100)
 * @returns {string} Complete SOSL query string ready to execute
 */
export function buildSoslQuery({ searchTerm, objectApiName, searchApiNames, allQueryApiNames, filter, maxResults }) {
    const findTerm = "*" + sanitizeSoslFindTerm(searchTerm) + "*";

    // Collect all fields needed (Id always first)
    const fieldSet = new Set(["Id", ...allQueryApiNames, ...searchApiNames]);
    for (const c of (filter?.criteria || [])) {
        if (c.fieldPath && !c.fieldPath.includes(".")) fieldSet.add(c.fieldPath);
    }

    const whereParts = [];

    // Search LIKE conditions: narrow SOSL candidates to records matching the term in searchFields
    if (searchApiNames.length > 0) {
        const likeTerm = "%" + searchTerm.replace(/[%_\\]/g, "\\$&") + "%";
        whereParts.push("(" + searchApiNames.map((f) => `${f} LIKE '${likeTerm}'`).join(" OR ") + ")");
    }

    // Filter criteria with optional filter logic
    const criteria = filter?.criteria || [];
    if (criteria.length > 0) {
        const condMap = new Map(criteria.map((c, i) => [i + 1, buildSoslCondition(c)]));
        const filterWhere = filter?.filterLogic
            ? applySoslFilterLogic(filter.filterLogic, condMap)
            : [...condMap.values()].join(" AND ");
        if (filterWhere) whereParts.push("(" + filterWhere + ")");
    }

    const where = whereParts.length ? " WHERE " + whereParts.join(" AND ") : "";
    const lim = Math.min(maxResults || 10, 100);

    return `FIND '${findTerm}' IN ALL FIELDS RETURNING ${objectApiName}(${[...fieldSet].join(", ")}${where} LIMIT ${lim})`;
}
