/**
 * CustomRecordPickerSearchController
 * 
 * Provides dynamic SOSL search functionality for the CustomRecordPicker LWC component.
 * SOSL is more powerful than SOQL for text search:
 * - Full-text search across multiple fields simultaneously
 * - Better substring/prefix matching capabilities
 * - Index-based performance optimization
 */
public with sharing class CustomRecordPickerSearchController {

    /**
     * Represents a search request from the LWC component
     */
    public class SearchRequest {
        @AuraEnabled public String searchTerm { get; set; }
        @AuraEnabled public String objectApiName { get; set; }
        @AuraEnabled public List<String> searchFields { get; set; }
        @AuraEnabled public Integer maxResults { get; set; }
        @AuraEnabled public List<FilterCriterion> criteria { get; set; }
        @AuraEnabled public String filterLogic { get; set; }
    }

    /**
     * Represents a single filter criterion
     */
    public class FilterCriterion {
        @AuraEnabled public String fieldPath { get; set; }
        @AuraEnabled public String operator { get; set; }
        @AuraEnabled public Object value { get; set; }
        @AuraEnabled public String dataType { get; set; }
    }

    /**
     * Represents a search result with all requested fields
     */
    public class SearchResult {
        @AuraEnabled public String id;
        @AuraEnabled public Map<String, Object> fields;
        
        public SearchResult(String id, Map<String, Object> fields) {
            this.id = id;
            this.fields = fields;
        }
    }

    private static final Integer MAX_RESULTS_CAP = 100;
    private static final Set<String> ALLOWED_OPERATORS = new Set<String>{
        'eq', 'ne', 'like', 'gt', 'gte', 'lt', 'lte', 'in', 'nin'
    };

    /**
     * Executes a dynamic SOSL search with filtering
     * 
     * @param request The search request containing search term, object name, fields, and filters
     * @return List of SearchResult objects matching the criteria
     * @throws IllegalArgumentException if the request parameters are invalid
     */
    @AuraEnabled(cacheable=false)
    public static List<SearchResult> search(SearchRequest request) {
        // Validate request
        validateSearchRequest(request);

        // Build SOSL query
        String soslQuery = buildSoslQuery(request);
        
        // If we have additional SOQL filters, we need to apply them post-search
        // because SOSL doesn't support WHERE clauses directly
        List<List<SObject>> soslResultGroups = Search.query(soslQuery);
        List<SObject> soslResults = new List<SObject>();
        for (List<SObject> resultGroup : soslResultGroups) {
            soslResults.addAll(resultGroup);
        }
        
        // Apply SOQL-like filters to SOSL results
        List<SObject> filteredResults = applyFilters(soslResults, request);
        
        // Cap results
        Integer resultLimit = Math.min(request.maxResults != null ? request.maxResults : 10, MAX_RESULTS_CAP);
        if (filteredResults.size() > resultLimit) {
            List<SObject> limitedResults = new List<SObject>();
            for (Integer i = 0; i < resultLimit; i++) {
                limitedResults.add(filteredResults.get(i));
            }
            filteredResults = limitedResults;
        }
        
        // Convert to SearchResult objects with all requested fields
        return convertToSearchResults(filteredResults, request.objectApiName);
    }

    /**
     * Validates the search request parameters
     */
    private static void validateSearchRequest(SearchRequest request) {
        if (request == null) {
            throw new IllegalArgumentException('Search request cannot be null');
        }
        
        if (String.isBlank(request.objectApiName)) {
            throw new IllegalArgumentException('objectApiName is required');
        }
        
        if (String.isBlank(request.searchTerm)) {
            throw new IllegalArgumentException('searchTerm is required');
        }
        
        // Validate object name
        if (!isValidObjectName(request.objectApiName)) {
            throw new IllegalArgumentException('Invalid objectApiName: ' + request.objectApiName);
        }
        
        // Validate search fields if provided
        if (request.searchFields != null && !request.searchFields.isEmpty()) {
            for (String field : request.searchFields) {
                if (!isValidFieldPath(field)) {
                    throw new IllegalArgumentException('Invalid search field: ' + field);
                }
            }
        }
        
        // Validate filter criteria if provided
        if (request.criteria != null && !request.criteria.isEmpty()) {
            for (Integer i = 0; i < request.criteria.size(); i++) {
                FilterCriterion criterion = request.criteria.get(i);
                if (!isValidFieldPath(criterion.fieldPath)) {
                    throw new IllegalArgumentException('Invalid filter field path: ' + criterion.fieldPath);
                }
                if (!ALLOWED_OPERATORS.contains(criterion.operator.toLowerCase())) {
                    throw new IllegalArgumentException('Invalid operator: ' + criterion.operator);
                }
            }
        }
    }

    /**
     * Builds a dynamic SOSL query string with WHERE clauses for searchFields
     * 
     * Format: FIND {searchTerm} IN ALL FIELDS RETURNING ObjectName(
     *   fields WHERE field1 LIKE '%term%' OR field2 LIKE '%term%' ...
     * )
     * 
     * Strategy:
     *   1. FIND uses * wildcard for fast index-based prefix search
     *   2. WHERE clauses further refine results on specific searchFields using LIKE
     *   3. Additional filter criteria are applied post-search
     */
    private static String buildSoslQuery(SearchRequest request) {
        String searchTerm = sanitizeSoslTerm(request.searchTerm);
        
        // For FIND: use prefix wildcard (fast index search)
        // E.g., "dupont" → "dupont*" matches "Dupont SA", "Dupontier", etc.
        String soslTerm = searchTerm + '*';
        
        // Build field list (SOSL includes Id by default)
        List<String> allFields = new List<String>{'Id'};
        
        // Add search fields if specified
        if (request.searchFields != null && !request.searchFields.isEmpty()) {
            for (String field : request.searchFields) {
                if (!allFields.contains(field)) {
                    allFields.add(field);
                }
            }
        }
        
        // Add filter criterion fields
        if (request.criteria != null) {
            for (FilterCriterion criterion : request.criteria) {
                String baseField = criterion.fieldPath.split('\\.')[0];
                if (!allFields.contains(baseField)) {
                    allFields.add(baseField);
                }
            }
        }
        
        // Build WHERE clause for searchFields (using LIKE for substring matching)
        // E.g.: WHERE Name LIKE '%dupont%' OR SIRETnumber__c LIKE '%dupont%'
        String whereClause = '';
        if (request.searchFields != null && !request.searchFields.isEmpty()) {
            List<String> searchConditions = new List<String>();
            // For LIKE: use both wildcards for substring matching
            // E.g., "dupont" → "%dupont%"
            String likeSearchTerm = '%' + sanitizeLikeTerm(request.searchTerm) + '%';
            
            for (String field : request.searchFields) {
                searchConditions.add(field + ' LIKE \'' + likeSearchTerm + '\'');
            }
            
            if (!searchConditions.isEmpty()) {
                whereClause = ' WHERE ' + String.join(searchConditions, ' OR ');
            }
        }
        
        // Build the SOSL query
        Integer resultLimit = Math.min(request.maxResults != null ? request.maxResults : 10, MAX_RESULTS_CAP);
        String query = 'FIND \'' + soslTerm + '\' IN ALL FIELDS RETURNING ' +
                       request.objectApiName + '(' + String.join(allFields, ', ') + 
                       whereClause + ' LIMIT ' + resultLimit + ')';
        
        return query;
    }

    /**
     * Applies SOQL-like filters to SOSL results
     * Since SOSL doesn't support WHERE clauses in standard Apex SOSL syntax,
     * we filter the results in memory
     */
    private static List<SObject> applyFilters(List<SObject> results, SearchRequest request) {
        if (request.criteria == null || request.criteria.isEmpty()) {
            return results;
        }
        
        List<SObject> filtered = new List<SObject>();
        
        for (SObject record : results) {
            if (evaluateFilters(record, request.criteria, request.filterLogic)) {
                filtered.add(record);
            }
        }
        
        return filtered;
    }

    /**
     * Evaluates all filter criteria against a record
     */
    private static Boolean evaluateFilters(SObject record, List<FilterCriterion> criteria, String filterLogic) {
        if (criteria == null || criteria.isEmpty()) {
            return true;
        }
        
        // If no filterLogic is provided, apply AND logic to all criteria
        if (String.isBlank(filterLogic)) {
            for (FilterCriterion criterion : criteria) {
                if (!evaluateCriterion(record, criterion)) {
                    return false;
                }
            }
            return true;
        }
        
        // Parse and evaluate complex filter logic
        // For simplicity, we'll evaluate all criteria and substitute into the logic string
        Map<Integer, Boolean> criterionResults = new Map<Integer, Boolean>();
        for (Integer i = 0; i < criteria.size(); i++) {
            criterionResults.put(i + 1, evaluateCriterion(record, criteria.get(i)));
        }
        
        return evaluateFilterLogic(filterLogic, criterionResults);
    }

    /**
     * Evaluates a single filter criterion against a record
     */
    private static Boolean evaluateCriterion(SObject record, FilterCriterion criterion) {
        Object fieldValue = getFieldValue(record, criterion.fieldPath);
        Object compareValue = parseCompareValue(criterion.value, criterion.dataType);
        String operator = criterion.operator.toLowerCase();
        
        switch on operator {
            when 'eq' {
                return performEqualsComparison(fieldValue, compareValue, criterion.dataType);
            }
            when 'ne' {
                return !performEqualsComparison(fieldValue, compareValue, criterion.dataType);
            }
            when 'like' {
                return performLikeComparison(fieldValue, compareValue);
            }
            when 'gt' {
                return performComparison(fieldValue, compareValue, criterion.dataType) > 0;
            }
            when 'gte' {
                return performComparison(fieldValue, compareValue, criterion.dataType) >= 0;
            }
            when 'lt' {
                return performComparison(fieldValue, compareValue, criterion.dataType) < 0;
            }
            when 'lte' {
                return performComparison(fieldValue, compareValue, criterion.dataType) <= 0;
            }
            when 'in' {
                return performInComparison(fieldValue, compareValue);
            }
            when 'nin' {
                return !performInComparison(fieldValue, compareValue);
            }
            when else {
                throw new IllegalArgumentException('Unknown operator: ' + operator);
            }
        }
    }

    /**
     * Parses the compare value based on data type
     */
    private static Object parseCompareValue(Object value, String dataType) {
        if (value == null) return null;
        
        if (dataType != null && dataType.toLowerCase().contains('date')) {
            if (value instanceof Map<String, Object>) {
                Map<String, Object> valueMap = (Map<String, Object>)value;
                if (valueMap.containsKey('literal')) {
                    String literal = (String)valueMap.get('literal');
                    return parseDateLiteral(literal);
                }
            }
        }
        
        return value;
    }

    /**
     * Parses date literals like LAST_N_YEARS:5
     */
    private static DateTime parseDateLiteral(String literal) {
        if (String.isBlank(literal)) return null;
        
        String upperLiteral = literal.toUpperCase().trim();
        DateTime now = DateTime.now();
        
        if (upperLiteral.startsWith('LAST_N_YEARS:')) {
            Integer years = Integer.valueOf(upperLiteral.substringAfter('LAST_N_YEARS:'));
            return now.addYears(-years);
        }
        if (upperLiteral.startsWith('LAST_N_DAYS:')) {
            Integer days = Integer.valueOf(upperLiteral.substringAfter('LAST_N_DAYS:'));
            return now.addDays(-days);
        }
        if (upperLiteral == 'TOMORROW') {
            return now.addDays(1);
        }
        if (upperLiteral == 'TODAY') {
            return DateTime.newInstance(Date.today(), Time.newInstance(0, 0, 0, 0));
        }
        if (upperLiteral == 'YESTERDAY') {
            return now.addDays(-1);
        }
        
        // Add more literals as needed
        return null;
    }
        String[] parts = fieldPath.split('\\.');
        Object current = record;
        
        for (String part : parts) {
            if (current == null) {
                return null;
            }
            
            if (current instanceof SObject) {
                current = ((SObject)current).get(part);
            } else {
                return null;
            }
        }
        
        return current;
    }

    /**
     * Performs LIKE comparison (substring matching)
     * Supports % as wildcard
     */
    private static Boolean performLikeComparison(Object fieldValue, Object compareValue) {
        if (fieldValue == null || compareValue == null) {
            return fieldValue == compareValue;
        }
        
        String fieldStr = String.valueOf(fieldValue).toLowerCase();
        String compareStr = String.valueOf(compareValue).toLowerCase();
        
        // Simple LIKE pattern matching for % wildcards
        if (compareStr.startsWith('%') && compareStr.endsWith('%') && compareStr.length() > 1) {
            String content = compareStr.substring(1, compareStr.length() - 1);
            return fieldStr.contains(content);
        }
        if (compareStr.startsWith('%') && compareStr.length() > 1) {
            String suffix = compareStr.substring(1);
            return fieldStr.endsWith(suffix);
        }
        if (compareStr.endsWith('%') && compareStr.length() > 1) {
            String prefix = compareStr.substring(0, compareStr.length() - 1);
            return fieldStr.startsWith(prefix);
        }
        
        return fieldStr == compareStr;
    }

    /**
     * Performs equals comparison based on data type
     */
    private static Boolean performEqualsComparison(Object left, Object right, String dataType) {
        if (left == null || right == null) {
            return left == right;
        }
        
        if (dataType != null && dataType.toLowerCase().contains('date')) {
            DateTime leftDate = (DateTime)left;
            DateTime rightDate = (DateTime)right;
            return leftDate == rightDate;
        }
        
        return left == right;
    }

    /**
     * Performs comparison (<, >, <=, >=) based on data type
     * Returns: negative if left < right, 0 if equal, positive if left > right
     */
    private static Integer performComparison(Object left, Object right, String dataType) {
        if (left == null || right == null) {
            return left == right ? 0 : (left == null ? -1 : 1);
        }
        
        if (dataType != null && dataType.toLowerCase().contains('date')) {
            DateTime leftDate = (DateTime)left;
            DateTime rightDate = (DateTime)right;
            if (leftDate < rightDate) return -1;
            if (leftDate > rightDate) return 1;
            return 0;
        }
        
        // Try numeric comparison first
        try {
            Decimal leftVal = Decimal.valueOf(String.valueOf(left));
            Decimal rightVal = Decimal.valueOf(String.valueOf(right));
            if (leftVal < rightVal) return -1;
            if (leftVal > rightVal) return 1;
            return 0;
        } catch (Exception e) {
            // Fall back to string comparison
            String leftStr = String.valueOf(left);
            String rightStr = String.valueOf(right);
            return leftStr.compareTo(rightStr);
        }
    }

    /**
     * Performs IN comparison
     */
    private static Boolean performInComparison(Object fieldValue, Object compareValue) {
        if (compareValue instanceof List<Object>) {
            List<Object> compareList = (List<Object>)compareValue;
            return compareList.contains(fieldValue);
        }
        return false;
    }

    /**
     * Evaluates complex filter logic (e.g., "1 OR 2 AND 3")
     * Simple recursive descent parser
     */
    private static Boolean evaluateFilterLogic(String logic, Map<Integer, Boolean> results) {
        if (String.isBlank(logic)) {
            return true;
        }
        
        // Simple approach: evaluate OR operations first (lower precedence in boolean algebra)
        // Then evaluate AND operations
        String normalizedLogic = logic.trim().toUpperCase();
        
        // Replace criterion numbers with their boolean values
        for (Integer key : results.keySet()) {
            String replacement = results.get(key) ? 'T' : 'F';
            normalizedLogic = normalizedLogic.replaceAll('\\b' + key + '\\b', replacement);
        }
        
        return evaluateBooleanExpression(normalizedLogic);
    }

    /**
     * Evaluates a boolean expression (T/F with AND/OR/NOT operators)
     * Simple precedence: NOT > AND > OR
     */
    private static Boolean evaluateBooleanExpression(String expr) {
        expr = expr.trim();
        
        // Handle NOT operations
        while (expr.contains('NOT')) {
            Integer notIdx = expr.indexOf('NOT');
            Integer endIdx = notIdx + 4;
            
            // Skip whitespace
            while (endIdx < expr.length() && expr.substring(endIdx, endIdx + 1) == ' ') {
                endIdx++;
            }
            
            // Get the next operand or parenthesized expression
            String nextChar = expr.substring(endIdx, endIdx + 1);
            Boolean operandResult;
            Integer consumeUntil;
            
            if (nextChar == '(') {
                // Find matching closing paren
                Integer parenCount = 1;
                Integer searchIdx = endIdx + 1;
                while (searchIdx < expr.length() && parenCount > 0) {
                    String currentChar = expr.substring(searchIdx, searchIdx + 1);
                    if (currentChar == '(') parenCount++;
                    else if (currentChar == ')') parenCount--;
                    searchIdx++;
                }
                String subExpr = expr.substring(endIdx + 1, searchIdx - 1);
                operandResult = evaluateBooleanExpression(subExpr);
                consumeUntil = searchIdx;
            } else {
                // Single T or F
                operandResult = (nextChar == 'T');
                consumeUntil = endIdx + 1;
            }
            
            String replacement = (!operandResult) ? 'T' : 'F';
            expr = expr.substring(0, notIdx) + replacement + expr.substring(consumeUntil);
        }
        
        // Handle AND operations
        while (expr.contains('AND')) {
            Integer andIdx = expr.indexOf('AND');
            
            // Find left operand (must be T or F)
            Integer leftStart = andIdx - 1;
            while (leftStart >= 0 && expr.substring(leftStart, leftStart + 1) == ' ') {
                leftStart--;
            }
            
            Boolean leftVal = (expr.substring(leftStart, leftStart + 1) == 'T');
            
            // Find right operand
            Integer rightStart = andIdx + 4;
            while (rightStart < expr.length() && expr.substring(rightStart, rightStart + 1) == ' ') {
                rightStart++;
            }
            
            Boolean rightVal = (expr.substring(rightStart, rightStart + 1) == 'T');
            
            Boolean result = leftVal && rightVal;
            String replacement = result ? 'T' : 'F';
            
            expr = expr.substring(0, leftStart) + replacement + expr.substring(rightStart + 1);
        }
        
        // Handle OR operations
        while (expr.contains('OR')) {
            Integer orIdx = expr.indexOf('OR');
            
            // Find left operand
            Integer leftStart = orIdx - 1;
            while (leftStart >= 0 && expr.substring(leftStart, leftStart + 1) == ' ') {
                leftStart--;
            }
            
            Boolean leftVal = (expr.substring(leftStart, leftStart + 1) == 'T');
            
            // Find right operand
            Integer rightStart = orIdx + 2;
            while (rightStart < expr.length() && expr.substring(rightStart, rightStart + 1) == ' ') {
                rightStart++;
            }
            
            Boolean rightVal = (expr.substring(rightStart, rightStart + 1) == 'T');
            
            Boolean result = leftVal || rightVal;
            String replacement = result ? 'T' : 'F';
            
            expr = expr.substring(0, leftStart) + replacement + expr.substring(rightStart + 1);
        }
        
        // Final result should be a single T or F
        return expr.trim() == 'T';
    }

    /**
     * Converts SObject results to SearchResult objects
     */
    private static List<SearchResult> convertToSearchResults(List<SObject> records, String objectApiName) {
        List<SearchResult> results = new List<SearchResult>();
        
        for (SObject record : records) {
            String id = (String)record.get('Id');
            Map<String, Object> fields = record.getPopulatedFieldsAsMap();
            results.add(new SearchResult(id, fields));
        }
        
        return results;
    }

    /**
     * Sanitizes SOSL search terms (escapes special characters)
     * Keeps SOSL special chars that have meaning in FIND
     */
    private static String sanitizeSoslTerm(String term) {
        if (String.isBlank(term)) {
            return '';
        }
        
        // Escape SOSL special characters: ? & | ! { } [ ] ( ) ^ ~ : \ " '  + -
        String sanitized = term;
        sanitized = sanitized.replace('\\', '\\\\');
        sanitized = sanitized.replace('?', '\\?');
        sanitized = sanitized.replace('&', '\\&');
        sanitized = sanitized.replace('|', '\\|');
        sanitized = sanitized.replace('!', '\\!');
        sanitized = sanitized.replace('{', '\\{');
        sanitized = sanitized.replace('}', '\\}');
        sanitized = sanitized.replace('[', '\\[');
        sanitized = sanitized.replace(']', '\\]');
        sanitized = sanitized.replace('(', '\\(');
        sanitized = sanitized.replace(')', '\\)');
        sanitized = sanitized.replace('^', '\\^');
        sanitized = sanitized.replace('~', '\\~');
        sanitized = sanitized.replace(':', '\\:');
        sanitized = sanitized.replace('"', '\\"');
        sanitized = sanitized.replace('\'', '\\\'');
        sanitized = sanitized.replace('+', '\\+');
        sanitized = sanitized.replace('-', '\\-');
        
        return sanitized;
    }

    /**
     * Sanitizes LIKE search terms (escapes SQL LIKE special characters)
     * % = wildcard (any chars), _ = single char → must be escaped if literal
     */
    private static String sanitizeLikeTerm(String term) {
        if (String.isBlank(term)) {
            return '';
        }
        
        String sanitized = term;
        // Escape LIKE wildcard characters
        sanitized = sanitized.replace('\\', '\\\\');
        sanitized = sanitized.replace('%', '\\%');
        sanitized = sanitized.replace('_', '\\_');
        
        return sanitized;
    }

    /**
     * Validates a field path (simple vs nested fields)
     */
    private static Boolean isValidFieldPath(String fieldPath) {
        if (String.isBlank(fieldPath)) {
            return false;
        }
        
        String[] parts = fieldPath.split('\\.');
        for (String part : parts) {
            if (!isValidFieldName(part)) {
                return false;
            }
        }
        
        return true;
    }

    /**
     * Validates an individual field name
     */
    private static Boolean isValidFieldName(String fieldName) {
        if (String.isBlank(fieldName)) {
            return false;
        }
        
        if (fieldName.length() == 0) {
            return false;
        }
        String firstChar = fieldName.substring(0, 1);
        Boolean validFirst = (firstChar >= 'A' && firstChar <= 'Z') ||
                             (firstChar >= 'a' && firstChar <= 'z') ||
                             (firstChar == '_');
        if (!validFirst) {
            return false;
        }
        for (Integer i = 1; i < fieldName.length(); i++) {
            String ch = fieldName.substring(i, i + 1);
            Boolean validChar = (ch >= 'A' && ch <= 'Z') ||
                                (ch >= 'a' && ch <= 'z') ||
                                (ch >= '0' && ch <= '9') ||
                                (ch == '_');
            if (!validChar) {
                return false;
            }
        }
        return true;
    }

    /**
     * Validates an object API name
     */
    private static Boolean isValidObjectName(String objectName) {
        if (String.isBlank(objectName)) {
            return false;
        }
        
        // Object names follow similar rules as field names, with optional __c or __e suffix
        String lowerName = objectName.toLowerCase();
        if (lowerName.endsWith('__c') || lowerName.endsWith('__e')) {
            String baseName = objectName.substring(0, objectName.length() - 3);
            return isValidFieldName(baseName);
        }
        return isValidFieldName(objectName);
    }
}
