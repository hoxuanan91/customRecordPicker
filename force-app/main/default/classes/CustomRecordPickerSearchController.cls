/**
 * CustomRecordPickerSearchController
 *
 * Executes a pre-built SOSL query string sent by the LWC component.
 * Query construction (field list, WHERE clause, filter logic) is done
 * entirely in JS (customRecordPickerUtils.buildSoslQuery) to keep value
 * formatting simple and avoid Apex deserialization edge cases.
 */
public with sharing class CustomRecordPickerSearchController {

    /** Search request — just the pre-built SOSL string from JS. */
    public class SearchRequest {
        @AuraEnabled public String soslQuery { get; set; }
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
     * @param request  Contains the pre-built soslQuery string
     * @return         List of SearchResult objects
     */
    @AuraEnabled(cacheable=false)
    public static List<SearchResult> search(SearchRequest request) {
        if (request == null || String.isBlank(request.soslQuery)) {
            throw new IllegalArgumentException('soslQuery is required');
        }
        // Basic structural guard: must start with FIND '
        if (!request.soslQuery.trim().toUpperCase().startsWith('FIND \'')) {
            throw new IllegalArgumentException('Invalid SOSL query format');
        }

        try {
            List<List<SObject>> resultGroups = Search.query(request.soslQuery);
            List<SObject> records = new List<SObject>();
            for (List<SObject> group : resultGroups) {
                records.addAll(group);
            }
            return convertToSearchResults(records);
        } catch (Exception e) {
            throw new IllegalArgumentException('SOSL query execution failed: ' + e.getMessage() + '. Query: ' + request.soslQuery);
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
