/**
 * CustomRecordPickerSearchController
 *
 * Executes a pre-built SOSL query string sent by the LWC component.
 * Query construction (field list, WHERE clause, filter logic) is done
 * entirely in JS (customRecordPickerUtils.buildSoslQuery) to keep value
 * formatting simple and avoid Apex deserialization edge cases.
 */
public with sharing class CustomRecordPickerSearchController {

    /** Search request — user input and developer-configured returning clause kept separate. */
    public class SearchRequest {
        @AuraEnabled public String searchTerm { get; set; }
        @AuraEnabled public String returningClause { get; set; }
    }

    /** Search result returned to the LWC component. */
    public class SearchResult {
        @AuraEnabled public String id;
        @AuraEnabled public Map<String, Object> fields;

        public SearchResult(String id, Map<String, Object> fields) {
            this.id = id;
            this.fields = fields;
        }
    }

    /**
     * Executes the SOSL query built by the LWC component and returns matching records.
     *
     * @param request  Contains searchTerm (user input) and returningClause (developer config)
     * @return         List of SearchResult objects
     */
    @AuraEnabled(cacheable=false)
    public static List<SearchResult> search(SearchRequest request) {
        if (request == null || String.isBlank(request.searchTerm) || String.isBlank(request.returningClause)) {
            throw new IllegalArgumentException('searchTerm and returningClause are required');
        }
        // returningClause is developer-configured (not user input) — guard against single quotes
        if (request.returningClause.contains('\'')) {
            throw new IllegalArgumentException('Invalid returningClause');
        }
        // Escape user input before embedding in FIND clause
        String safeTerm = '*' + String.escapeSingleQuotes(request.searchTerm) + '*';
        String soslQuery = 'FIND \'' + safeTerm + '\' IN ALL FIELDS RETURNING ' + request.returningClause;

        try {
            List<List<SObject>> resultGroups = Search.query(soslQuery);
            List<SObject> records = new List<SObject>();
            for (List<SObject> g : resultGroups) {
                records.addAll(g);
            }
            return convertToSearchResults(records);
        } catch (Exception e) {
            throw new IllegalArgumentException('SOSL query execution failed: ' + e.getMessage() + '. Query: ' + soslQuery);
        }
    }

    private static List<SearchResult> convertToSearchResults(List<SObject> records) {
        List<SearchResult> results = new List<SearchResult>();
        for (SObject record : records) {
            results.add(new SearchResult((String) record.get('Id'), record.getPopulatedFieldsAsMap()));
        }
        return results;
    }
}
