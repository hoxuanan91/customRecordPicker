/**
 * Unit tests for customRecordPickerUtils.js — pure functions, no LWC runtime needed.
 */
import {
    validateFieldPath,
    validateObjectName,
    validateOperator,
    sanitizeSearchTerm,
    tokenize,
    parseFilterLogic,
    flattenLogic,
    fieldToGraphQL,
    fieldPathToWhereNesting,
    serializeWhereClause,
    isDateLiteral,
    inferGraphQLType,
} from "../customRecordPickerUtils";

// ═══════════════════════════════════════════════════════════════════════════════
// validateFieldPath
// ═══════════════════════════════════════════════════════════════════════════════
describe("validateFieldPath", () => {
    it("does not throw for valid simple field", () => {
        expect(() => validateFieldPath("Name", "Name")).not.toThrow();
    });
    it("does not throw for custom field with __c", () => {
        expect(() => validateFieldPath("PersonNumber__c", "x")).not.toThrow();
    });
    it("does not throw for relationship field", () => {
        expect(() => validateFieldPath("Account.Name", "x")).not.toThrow();
    });
    it("does not throw for null/undefined (optional)", () => {
        expect(() => validateFieldPath(null, "x")).not.toThrow();
        expect(() => validateFieldPath(undefined, "x")).not.toThrow();
    });
    it("throws for field with spaces", () => {
        expect(() => validateFieldPath("Invalid Field", "x")).toThrow();
    });
    it("throws for field with special chars", () => {
        expect(() => validateFieldPath("Name!", "x")).toThrow();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// validateObjectName
// ═══════════════════════════════════════════════════════════════════════════════
describe("validateObjectName", () => {
    it("does not throw for standard object", () => {
        expect(() => validateObjectName("Account")).not.toThrow();
    });
    it("does not throw for custom object", () => {
        expect(() => validateObjectName("MyObject__c")).not.toThrow();
    });
    it("does not throw for null/undefined", () => {
        expect(() => validateObjectName(null)).not.toThrow();
    });
    it("throws for object name with spaces", () => {
        expect(() => validateObjectName("My Object")).toThrow();
    });
    it("throws for object name with special chars", () => {
        expect(() => validateObjectName("My-Object")).toThrow();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// validateOperator
// ═══════════════════════════════════════════════════════════════════════════════
describe("validateOperator", () => {
    const valid = ["eq", "ne", "like", "gt", "gte", "lt", "lte", "in", "nin"];
    valid.forEach((op) => {
        it(`does not throw for operator "${op}"`, () => {
            expect(() => validateOperator(op)).not.toThrow();
        });
    });
    it("throws for unknown operator", () => {
        expect(() => validateOperator("contains")).toThrow();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// sanitizeSearchTerm
// ═══════════════════════════════════════════════════════════════════════════════
describe("sanitizeSearchTerm", () => {
    it("escapes %", () => {
        expect(sanitizeSearchTerm("50%")).toBe("50\\%");
    });
    it("escapes _", () => {
        expect(sanitizeSearchTerm("test_user")).toBe("test\\_user");
    });
    it("escapes both % and _", () => {
        expect(sanitizeSearchTerm("50%_off")).toBe("50\\%\\_off");
    });
    it("leaves normal strings unchanged", () => {
        expect(sanitizeSearchTerm("hello world")).toBe("hello world");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// tokenize
// ═══════════════════════════════════════════════════════════════════════════════
describe("tokenize", () => {
    it("tokenizes numbers", () => {
        expect(tokenize("1")).toEqual([{ type: "NUMBER", value: 1 }]);
    });
    it("tokenizes AND", () => {
        expect(tokenize("1 AND 2")).toEqual([
            { type: "NUMBER", value: 1 },
            { type: "AND" },
            { type: "NUMBER", value: 2 },
        ]);
    });
    it("tokenizes OR", () => {
        expect(tokenize("1 OR 2")).toEqual([
            { type: "NUMBER", value: 1 },
            { type: "OR" },
            { type: "NUMBER", value: 2 },
        ]);
    });
    it("tokenizes NOT", () => {
        expect(tokenize("NOT 1")).toEqual([
            { type: "NOT" },
            { type: "NUMBER", value: 1 },
        ]);
    });
    it("tokenizes parentheses", () => {
        expect(tokenize("(1 OR 2)")).toEqual([
            { type: "LPAREN" },
            { type: "NUMBER", value: 1 },
            { type: "OR" },
            { type: "NUMBER", value: 2 },
            { type: "RPAREN" },
        ]);
    });
    it("ignores extra whitespace", () => {
        expect(tokenize("  1   AND   2  ")).toEqual([
            { type: "NUMBER", value: 1 },
            { type: "AND" },
            { type: "NUMBER", value: 2 },
        ]);
    });
    it("throws for unexpected character", () => {
        expect(() => tokenize("1 $ 2")).toThrow();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseFilterLogic + flattenLogic
// ═══════════════════════════════════════════════════════════════════════════════
describe("parseFilterLogic", () => {
    const c1 = { _raw: "{ A: { eq: 1 } }" };
    const c2 = { _raw: "{ B: { eq: 2 } }" };
    const c3 = { _raw: "{ C: { eq: 3 } }" };

    function map(...items) {
        const m = new Map();
        items.forEach((item, i) => m.set(i + 1, item));
        return m;
    }

    it("parses single criterion", () => {
        const result = parseFilterLogic("1", map(c1));
        expect(result).toBe(c1);
    });

    it("parses '1 AND 2'", () => {
        const result = parseFilterLogic("1 AND 2", map(c1, c2));
        expect(result).toEqual({ and: [c1, c2] });
    });

    it("parses '1 OR 2'", () => {
        const result = parseFilterLogic("1 OR 2", map(c1, c2));
        expect(result).toEqual({ or: [c1, c2] });
    });

    it("parses 'NOT 1'", () => {
        const result = parseFilterLogic("NOT 1", map(c1));
        expect(result).toEqual({ not: c1 });
    });

    it("parses '(1 OR 2) AND 3'", () => {
        const result = parseFilterLogic("(1 OR 2) AND 3", map(c1, c2, c3));
        expect(result).toEqual({ and: [{ or: [c1, c2] }, c3] });
    });

    it("throws for unknown criterion index", () => {
        expect(() => parseFilterLogic("5", map(c1))).toThrow();
    });

    it("throws for trailing tokens", () => {
        expect(() => parseFilterLogic("1 2", map(c1, c2))).toThrow();
    });
});

describe("flattenLogic", () => {
    it("returns node unchanged if no nesting", () => {
        const node = { _raw: "x" };
        expect(flattenLogic(node)).toBe(node);
    });

    it("flattens nested AND into a single array", () => {
        const c1 = { _raw: "a" };
        const c2 = { _raw: "b" };
        const c3 = { _raw: "c" };
        const nested = { and: [{ and: [c1, c2] }, c3] };
        expect(flattenLogic(nested)).toEqual({ and: [c1, c2, c3] });
    });

    it("flattens nested OR into a single array", () => {
        const c1 = { _raw: "a" };
        const c2 = { _raw: "b" };
        const c3 = { _raw: "c" };
        const nested = { or: [{ or: [c1, c2] }, c3] };
        expect(flattenLogic(nested)).toEqual({ or: [c1, c2, c3] });
    });

    it("preserves NOT", () => {
        const c1 = { _raw: "a" };
        expect(flattenLogic({ not: c1 })).toEqual({ not: c1 });
    });

    it("returns null/undefined unchanged", () => {
        expect(flattenLogic(null)).toBeNull();
        expect(flattenLogic(undefined)).toBeUndefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// fieldToGraphQL
// ═══════════════════════════════════════════════════════════════════════════════
describe("fieldToGraphQL", () => {
    it("renders simple field with value/displayValue", () => {
        expect(fieldToGraphQL("Name")).toBe("Name { value displayValue }");
    });

    it("renders Id field without wrapper", () => {
        expect(fieldToGraphQL("Id")).toBe("Id");
    });

    it("renders relationship field", () => {
        expect(fieldToGraphQL("Owner.Name")).toBe(
            "Owner { Name { value displayValue } }",
        );
    });

    it("renders deep relationship field", () => {
        expect(fieldToGraphQL("Owner.Profile.Name")).toBe(
            "Owner { Profile { Name { value displayValue } } }",
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// fieldPathToWhereNesting
// ═══════════════════════════════════════════════════════════════════════════════
describe("fieldPathToWhereNesting", () => {
    it("returns simple field with empty suffix", () => {
        expect(fieldPathToWhereNesting("Name")).toEqual({ prefix: "Name", suffix: "" });
    });

    it("returns nested field with closing braces", () => {
        const result = fieldPathToWhereNesting("Owner.Name");
        expect(result.prefix).toBe("Owner: { Name");
        expect(result.suffix).toBe(" }");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// serializeWhereClause
// ═══════════════════════════════════════════════════════════════════════════════
describe("serializeWhereClause", () => {
    it("returns empty string for null", () => {
        expect(serializeWhereClause(null)).toBe("");
    });

    it("returns _raw value directly", () => {
        expect(serializeWhereClause({ _raw: "{ X: { eq: 1 } }" })).toBe("{ X: { eq: 1 } }");
    });

    it("serializes AND node", () => {
        const result = serializeWhereClause({
            and: [{ _raw: "A" }, { _raw: "B" }],
        });
        expect(result).toBe("{ and: [A, B] }");
    });

    it("serializes OR node", () => {
        const result = serializeWhereClause({
            or: [{ _raw: "A" }, { _raw: "B" }],
        });
        expect(result).toBe("{ or: [A, B] }");
    });

    it("serializes NOT node", () => {
        const result = serializeWhereClause({ not: { _raw: "A" } });
        expect(result).toBe("{ not: A }");
    });

    it("serializes nested AND+OR", () => {
        const result = serializeWhereClause({
            and: [
                { or: [{ _raw: "A" }, { _raw: "B" }] },
                { _raw: "C" },
            ],
        });
        expect(result).toBe("{ and: [{ or: [A, B] }, C] }");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// isDateLiteral
// ═══════════════════════════════════════════════════════════════════════════════
describe("isDateLiteral", () => {
    it("returns true for { literal: 'TODAY' }", () => {
        expect(isDateLiteral({ literal: "TODAY" })).toBe(true);
    });
    it("returns true for { literal: 'LAST_MONTH' }", () => {
        expect(isDateLiteral({ literal: "LAST_MONTH" })).toBe(true);
    });
    it("returns false for string", () => {
        expect(isDateLiteral("TODAY")).toBe(false);
    });
    it("returns false for null", () => {
        expect(isDateLiteral(null)).toBe(false);
    });
    it("returns false for object without literal", () => {
        expect(isDateLiteral({ value: "TODAY" })).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// inferGraphQLType
// ═══════════════════════════════════════════════════════════════════════════════
describe("inferGraphQLType", () => {
    it("returns String for null", () => {
        expect(inferGraphQLType(null)).toBe("String");
    });
    it("returns Date for date literal", () => {
        expect(inferGraphQLType({ literal: "TODAY" })).toBe("Date");
    });
    it("returns ID for 15-char Salesforce ID", () => {
        expect(inferGraphQLType("001xx000003GHPY")).toBe("ID");
    });
    it("returns ID for 18-char Salesforce ID", () => {
        expect(inferGraphQLType("001xx000003GHPYAA4")).toBe("ID");
    });
    it("returns Int for integer", () => {
        expect(inferGraphQLType(42)).toBe("Int");
    });
    it("returns Float for decimal", () => {
        expect(inferGraphQLType(3.14)).toBe("Float");
    });
    it("returns Boolean for boolean", () => {
        expect(inferGraphQLType(true)).toBe("Boolean");
        expect(inferGraphQLType(false)).toBe("Boolean");
    });
    it("returns String for regular string", () => {
        expect(inferGraphQLType("Customer")).toBe("String");
    });
});
