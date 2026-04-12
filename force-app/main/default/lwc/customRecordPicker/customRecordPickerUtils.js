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
