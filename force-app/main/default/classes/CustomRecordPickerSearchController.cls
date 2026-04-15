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
        
        try {
            // Execute SOSL search
            List<List<SObject>> soslResultGroups = Search.query(soslQuery);
            List<SObject> soslResults = new List<SObject>();
            for (List<SObject> resultGroup : soslResultGroups) {
                soslResults.addAll(resultGroup);
            }
            
            // Cap results
            Integer resultLimit = Math.min(request.maxResults != null ? request.maxResults : 10, MAX_RESULTS_CAP);
            if (soslResults.size() > resultLimit) {
                List<SObject> limitedResults = new List<SObject>();
                for (Integer i = 0; i < resultLimit; i++) {
                    limitedResults.add(soslResults.get(i));
                }
                soslResults = limitedResults;
            }
            
            // Convert to SearchResult objects with all requested fields
            return convertToSearchResults(soslResults, request.objectApiName);
        } catch (Exception e) {
            throw new IllegalArgumentException('SOSL query execution failed: ' + e.getMessage() + '. Query: ' + soslQuery);
        }
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
            }
        }
    }

    /**
     * Builds a dynamic SOSL query string with WHERE clauses for searchFields and criteria
     * 
     * Format: FIND {searchTerm} IN ALL FIELDS RETURNING ObjectName(
     *   fields WHERE (searchConditions) AND (filterConditions)
     * )
     * 
     * Strategy:
     *   1. FIND uses * wildcard for fast index-based prefix search
     *   2. WHERE combines search field LIKE conditions with filter criteria
     *   3. Complex filters that can't be expressed in SOSL are applied post-search
     */
    private static String buildSoslQuery(SearchRequest request) {
        String searchTerm = sanitizeSoslTerm(request.searchTerm);
        
        // For FIND: use prefix wildcard (fast index search)
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
        
        // Build WHERE conditions
        List<String> whereConditions = new List<String>();
        
        // Add search field LIKE conditions
        if (request.searchFields != null && !request.searchFields.isEmpty()) {
            List<String> searchConditions = new List<String>();
            String likeSearchTerm = '%' + sanitizeLikeTerm(request.searchTerm) + '%';
            
            for (String field : request.searchFields) {
                searchConditions.add(field + ' LIKE \'' + likeSearchTerm + '\'');
            }
            
            if (!searchConditions.isEmpty()) {
                whereConditions.add('(' + String.join(searchConditions, ' OR ') + ')');
            }
        }
        
        // Add filter criteria - all criteria must be included in SOSL WHERE
        if (request.criteria != null && !request.criteria.isEmpty()) {
            for (FilterCriterion criterion : request.criteria) {
                String soslCondition = buildSoslCondition(criterion);
                whereConditions.add(soslCondition);
            }
        }
        
        // Combine all WHERE conditions with AND
        String whereClause = '';
        if (!whereConditions.isEmpty()) {
            whereClause = ' WHERE ' + String.join(whereConditions, ' AND ');
        }
        
        // Build the SOSL query
        Integer resultLimit = Math.min(request.maxResults != null ? request.maxResults : 10, MAX_RESULTS_CAP);
        String query = 'FIND \'' + soslTerm + '\' IN ALL FIELDS RETURNING ' +
                       request.objectApiName + '(' + String.join(allFields, ', ') + 
                       whereClause + ' LIMIT ' + resultLimit + ')';
        
        return query;
    }

    /**
     * Builds a SOSL WHERE condition for a filter criterion
     */
    private static String buildSoslCondition(FilterCriterion criterion) {
        String field = criterion.fieldPath;
        String operator = criterion.operator.toLowerCase();
        Object value = criterion.value;
        
        String soslOperator;
        String soslValue;
        
        switch on operator {
            when 'eq' {
                soslOperator = '=';
                soslValue = formatSoslValue(value);
            }
            when 'ne' {
                soslOperator = '!=';
                soslValue = formatSoslValue(value);
            }
            when 'like' {
                soslOperator = 'LIKE';
                soslValue = formatSoslValue(value);
            }
            when 'gt' {
                soslOperator = '>';
                soslValue = formatSoslValue(value);
            }
            when 'gte' {
                soslOperator = '>=';
                soslValue = formatSoslValue(value);
            }
            when 'lt' {
                soslOperator = '<';
                soslValue = formatSoslValue(value);
            }
            when 'lte' {
                soslOperator = '<=';
                soslValue = formatSoslValue(value);
            }
            when 'in' {
                soslOperator = 'IN';
                soslValue = formatSoslInValue(value);
            }
            when 'nin' {
                soslOperator = 'NOT IN';
                soslValue = formatSoslInValue(value);
            }
            when else {
                throw new IllegalArgumentException('Unsupported operator: ' + operator);
            }
        }
        
        return field + ' ' + soslOperator + ' ' + soslValue;
    }

    /**
     * Formats a value for SOSL WHERE clause
     */
    private static String formatSoslValue(Object value) {
        if (value == null) {
            return 'null';
        }
        
        // Handle date literals
        if (value instanceof Map<String, Object>) {
            Map<String, Object> valueMap = (Map<String, Object>)value;
            if (valueMap.containsKey('literal')) {
                return (String)valueMap.get('literal');
            }
        }
        
        // Handle strings
        if (value instanceof String) {
            return '\'' + String.valueOf(value).replace('\'', '\\\'') + '\'';
        }
        
        // Handle numbers and booleans
        return String.valueOf(value);
    }

    /**
     * Formats a value for SOSL IN/NOT IN clause
     */
    private static String formatSoslInValue(Object value) {
        if (value == null) {
            return '(null)';
        }
        
        if (value instanceof List<Object>) {
            List<Object> values = (List<Object>)value;
            List<String> formattedValues = new List<String>();
            
            for (Object val : values) {
                formattedValues.add(formatSoslValue(val));
            }
            
            return '(' + String.join(formattedValues, ', ') + ')';
        }
        
        return '(' + formatSoslValue(value) + ')';
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
