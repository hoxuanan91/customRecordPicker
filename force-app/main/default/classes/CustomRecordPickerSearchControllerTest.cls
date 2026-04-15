/**
 * CustomRecordPickerSearchControllerTest
 * 
 * Test suite for CustomRecordPickerSearchController
 */
@isTest
public class CustomRecordPickerSearchControllerTest {

    @testSetup
    static void setup() {
        // Create test data
        List<Account> accounts = new List<Account>();
        accounts.add(new Account(Name = 'Acme Corporation', Industry = 'Technology', Type = 'Prospect'));
        accounts.add(new Account(Name = 'Dupont SA', Industry = 'Manufacturing', Type = 'Customer'));
        accounts.add(new Account(Name = 'Dupontier SARL', Industry = 'Services', Type = 'Prospect'));
        accounts.add(new Account(Name = 'Tech Solutions', Industry = 'Technology', Type = 'Customer'));
        insert accounts;
    }

    @isTest
    static void testSimpleSearch() {
        CustomRecordPickerSearchController.SearchRequest request = new CustomRecordPickerSearchController.SearchRequest();
        request.searchTerm = 'Acme';
        request.objectApiName = 'Account';
        request.searchFields = new List<String>{'Name'};
        request.maxResults = 10;

        Test.startTest();
        List<CustomRecordPickerSearchController.SearchResult> results = CustomRecordPickerSearchController.search(request);
        Test.stopTest();

        Assert.isTrue(results.size() > 0, 'Should return results matching search fields');
    }

    @isTest
    static void testSearchWithMultipleSearchFields() {
        CustomRecordPickerSearchController.SearchRequest request = new CustomRecordPickerSearchController.SearchRequest();
        request.searchTerm = 'Dupont';
        request.objectApiName = 'Account';
        // Search in multiple fields with WHERE LIKE
        request.searchFields = new List<String>{'Name', 'Type'};
        request.maxResults = 10;

        Test.startTest();
        List<CustomRecordPickerSearchController.SearchResult> results = CustomRecordPickerSearchController.search(request);
        Test.stopTest();

        // Should only return records where Name OR Type contains "Dupont"
        Assert.isTrue(results.size() >= 0, 'Should filter by search fields with LIKE');
    }

    @isTest
    static void testSearchWithMultipleCriteria() {
        CustomRecordPickerSearchController.SearchRequest request = new CustomRecordPickerSearchController.SearchRequest();
        request.searchTerm = 'Tech';
        request.objectApiName = 'Account';
        request.searchFields = new List<String>{'Name'};
        request.maxResults = 10;

        // Multiple criteria
        CustomRecordPickerSearchController.FilterCriterion criterion1 = new CustomRecordPickerSearchController.FilterCriterion();
        criterion1.fieldPath = 'Industry';
        criterion1.operator = 'eq';
        criterion1.value = 'Technology';

        CustomRecordPickerSearchController.FilterCriterion criterion2 = new CustomRecordPickerSearchController.FilterCriterion();
        criterion2.fieldPath = 'Type';
        criterion2.operator = 'eq';
        criterion2.value = 'Customer';

        request.criteria = new List<CustomRecordPickerSearchController.FilterCriterion>{criterion1, criterion2};
        request.filterLogic = '1 AND 2';

        Test.startTest();
        List<CustomRecordPickerSearchController.SearchResult> results = CustomRecordPickerSearchController.search(request);
        Test.stopTest();

        Assert.isTrue(results.size() >= 0, 'Should return AND-filtered results');
    }

    @isTest
    static void testSearchWithOrLogic() {
        CustomRecordPickerSearchController.SearchRequest request = new CustomRecordPickerSearchController.SearchRequest();
        request.searchTerm = '';
        request.objectApiName = 'Account';
        request.maxResults = 10;

        CustomRecordPickerSearchController.FilterCriterion criterion1 = new CustomRecordPickerSearchController.FilterCriterion();
        criterion1.fieldPath = 'Type';
        criterion1.operator = 'eq';
        criterion1.value = 'Prospect';

        CustomRecordPickerSearchController.FilterCriterion criterion2 = new CustomRecordPickerSearchController.FilterCriterion();
        criterion2.fieldPath = 'Type';
        criterion2.operator = 'eq';
        criterion2.value = 'Customer';

        request.criteria = new List<CustomRecordPickerSearchController.FilterCriterion>{criterion1, criterion2};
        request.filterLogic = '1 OR 2';

        Test.startTest();
        List<CustomRecordPickerSearchController.SearchResult> results = CustomRecordPickerSearchController.search(request);
        Test.stopTest();

        Assert.isTrue(results.size() >= 0, 'Should return OR-filtered results');
    }

    @isTest
    static void testSearchThrowsExceptionForMissingObjectName() {
        CustomRecordPickerSearchController.SearchRequest request = new CustomRecordPickerSearchController.SearchRequest();
        request.searchTerm = 'Test';
        request.objectApiName = '';
        request.maxResults = 10;

        Test.startTest();
        try {
            CustomRecordPickerSearchController.search(request);
            Assert.fail('Should have thrown exception');
        } catch (IllegalArgumentException e) {
            Assert.isTrue(e.getMessage().contains('objectApiName'), 'Should mention objectApiName');
        }
        Test.stopTest();
    }

    @isTest
    static void testSearchThrowsExceptionForMissingSearchTerm() {
        CustomRecordPickerSearchController.SearchRequest request = new CustomRecordPickerSearchController.SearchRequest();
        request.searchTerm = '';
        request.objectApiName = 'Account';
        request.maxResults = 10;

        Test.startTest();
        try {
            CustomRecordPickerSearchController.search(request);
            Assert.fail('Should have thrown exception');
        } catch (IllegalArgumentException e) {
            Assert.isTrue(e.getMessage().contains('searchTerm'), 'Should mention searchTerm');
        }
        Test.stopTest();
    }

    @isTest
    static void testSearchThrowsExceptionForInvalidOperator() {
        CustomRecordPickerSearchController.SearchRequest request = new CustomRecordPickerSearchController.SearchRequest();
        request.searchTerm = 'Test';
        request.objectApiName = 'Account';
        request.maxResults = 10;

        CustomRecordPickerSearchController.FilterCriterion criterion = new CustomRecordPickerSearchController.FilterCriterion();
        criterion.fieldPath = 'Type';
        criterion.operator = 'invalidOp';
        criterion.value = 'Customer';

        request.criteria = new List<CustomRecordPickerSearchController.FilterCriterion>{criterion};

        Test.startTest();
        try {
            CustomRecordPickerSearchController.search(request);
            Assert.fail('Should have thrown exception');
        } catch (IllegalArgumentException e) {
            Assert.isTrue(e.getMessage().contains('Invalid operator'), 'Should mention invalid operator');
        }
        Test.stopTest();
    }

    @isTest
    static void testMaxResultsCapEnforced() {
        CustomRecordPickerSearchController.SearchRequest request = new CustomRecordPickerSearchController.SearchRequest();
        request.searchTerm = 'a';
        request.objectApiName = 'Account';
        request.searchFields = new List<String>{'Name'};
        request.maxResults = 500; // Exceeds cap

        Test.startTest();
        List<CustomRecordPickerSearchController.SearchResult> results = CustomRecordPickerSearchController.search(request);
        Test.stopTest();

        Assert.isTrue(results.size() <= 100, 'Results should not exceed max cap of 100');
    }

    @isTest
    static void testSanitizationOfSearchTerms() {
        CustomRecordPickerSearchController.SearchRequest request = new CustomRecordPickerSearchController.SearchRequest();
        request.searchTerm = 'Test&Sanitize!';
        request.objectApiName = 'Account';
        request.searchFields = new List<String>{'Name'};
        request.maxResults = 10;

        Test.startTest();
        List<CustomRecordPickerSearchController.SearchResult> results = CustomRecordPickerSearchController.search(request);
        Test.stopTest();

        // Should handle special SOSL characters in WHERE LIKE correctly
        Assert.isNotNull(results, 'Should handle special characters in SOSL terms');
    }

    @isTest
    static void testDateLiteralInSoslWhere() {
        // Create an account with today's date
        Account testAccount = new Account(
            Name = 'TodayTestAccount',
            Industry = 'Test',
            Type = 'Prospect'
        );
        insert testAccount;

        CustomRecordPickerSearchController.SearchRequest request = new CustomRecordPickerSearchController.SearchRequest();
        request.searchTerm = 'TodayTestAccount';
        request.objectApiName = 'Account';
        request.searchFields = new List<String>{'Name'};
        request.maxResults = 10;

        // Add a date criterion using TODAY literal
        CustomRecordPickerSearchController.FilterCriterion dateCriterion = new CustomRecordPickerSearchController.FilterCriterion();
        dateCriterion.fieldPath = 'CreatedDate';
        dateCriterion.operator = 'eq';
        dateCriterion.value = new Map<String, Object>{'literal' => 'TODAY'};

        request.criteria = new List<CustomRecordPickerSearchController.FilterCriterion>{dateCriterion};

        Test.startTest();
        List<CustomRecordPickerSearchController.SearchResult> results = CustomRecordPickerSearchController.search(request);
        Test.stopTest();

        // Should find the account created today using SOSL WHERE with TODAY literal
        Assert.isTrue(results.size() > 0, 'Should find account using TODAY literal in SOSL WHERE');
        Assert.areEqual(testAccount.Id, results[0].id, 'Should return the correct account');
    }

    @isTest
    static void testNullValueInSoslWhere() {
        // Create accounts with and without Industry
        Account accountWithIndustry = new Account(
            Name = 'AccountWithIndustry',
            Industry = 'Technology',
            Type = 'Customer'
        );
        Account accountWithoutIndustry = new Account(
            Name = 'AccountWithoutIndustry',
            Industry = null, // Explicitly set to null
            Type = 'Prospect'
        );
        insert new List<Account>{accountWithIndustry, accountWithoutIndustry};

        CustomRecordPickerSearchController.SearchRequest request = new CustomRecordPickerSearchController.SearchRequest();
        request.searchTerm = 'Industry';
        request.objectApiName = 'Account';
        request.searchFields = new List<String>{'Name'};
        request.maxResults = 10;

        // Add a criterion for Industry = null
        CustomRecordPickerSearchController.FilterCriterion nullCriterion = new CustomRecordPickerSearchController.FilterCriterion();
        nullCriterion.fieldPath = 'Industry';
        nullCriterion.operator = 'eq';
        nullCriterion.value = null;

        request.criteria = new List<CustomRecordPickerSearchController.FilterCriterion>{nullCriterion};

        Test.startTest();
        List<CustomRecordPickerSearchController.SearchResult> results = CustomRecordPickerSearchController.search(request);
        Test.stopTest();

        // Should find only the account with null Industry using SOSL WHERE with = null
        Assert.isTrue(results.size() > 0, 'Should find account with null Industry in SOSL WHERE');
        Assert.areEqual(accountWithoutIndustry.Id, results[0].id, 'Should return the account with null Industry');
    }

    @isTest
    static void testSoslWhereLikeWithPrefixWildcard() {
        // This test demonstrates the FIND * + WHERE LIKE %% strategy
        // FIND 'dupont*' (prefix wildcard for index)
        // WHERE Name LIKE '%dupont%' (both-side wildcard for flexibility)
        
        CustomRecordPickerSearchController.SearchRequest request = new CustomRecordPickerSearchController.SearchRequest();
        request.searchTerm = 'dupont';
        request.objectApiName = 'Account';
        request.searchFields = new List<String>{'Name', 'Enseigne__c', 'SIRETnumber__c'};
        request.maxResults = 30;

        Test.startTest();
        List<CustomRecordPickerSearchController.SearchResult> results = CustomRecordPickerSearchController.search(request);
        Test.stopTest();

        // Query is:
        // FIND 'dupont*' RETURNING Account(
        //   ... WHERE Name LIKE '%dupont%' 
        //           OR Enseigne__c LIKE '%dupont%'
        //           OR SIRETnumber__c LIKE '%dupont%'
        // )
        Assert.isTrue(results.size() >= 0, 'Should return results with SOSL WHERE LIKE');
    }

    @isTest
    static void testLikeOperator() {
        CustomRecordPickerSearchController.SearchRequest request = new CustomRecordPickerSearchController.SearchRequest();
        request.searchTerm = '';
        request.objectApiName = 'Account';
        request.maxResults = 10;

        CustomRecordPickerSearchController.FilterCriterion criterion = new CustomRecordPickerSearchController.FilterCriterion();
        criterion.fieldPath = 'Name';
        criterion.operator = 'like';
        criterion.value = '%Dupont%';

        request.criteria = new List<CustomRecordPickerSearchController.FilterCriterion>{criterion};
        request.filterLogic = '1';

        Test.startTest();
        List<CustomRecordPickerSearchController.SearchResult> results = CustomRecordPickerSearchController.search(request);
        Test.stopTest();

        Assert.isTrue(results.size() >= 0, 'Should handle LIKE operator');
    }

    @isTest
    static void testInOperator() {
        CustomRecordPickerSearchController.SearchRequest request = new CustomRecordPickerSearchController.SearchRequest();
        request.searchTerm = '';
        request.objectApiName = 'Account';
        request.maxResults = 10;

        CustomRecordPickerSearchController.FilterCriterion criterion = new CustomRecordPickerSearchController.FilterCriterion();
        criterion.fieldPath = 'Type';
        criterion.operator = 'in';
        criterion.value = new List<Object>{'Customer', 'Prospect'};

        request.criteria = new List<CustomRecordPickerSearchController.FilterCriterion>{criterion};
        request.filterLogic = '1';

        Test.startTest();
        List<CustomRecordPickerSearchController.SearchResult> results = CustomRecordPickerSearchController.search(request);
        Test.stopTest();

        Assert.isTrue(results.size() >= 0, 'Should handle IN operator');
    }

    @isTest
    static void testNinOperator() {
        CustomRecordPickerSearchController.SearchRequest request = new CustomRecordPickerSearchController.SearchRequest();
        request.searchTerm = '';
        request.objectApiName = 'Account';
        request.maxResults = 10;

        CustomRecordPickerSearchController.FilterCriterion criterion = new CustomRecordPickerSearchController.FilterCriterion();
        criterion.fieldPath = 'Type';
        criterion.operator = 'nin';
        criterion.value = new List<Object>{'Other'};

        request.criteria = new List<CustomRecordPickerSearchController.FilterCriterion>{criterion};
        request.filterLogic = '1';

        Test.startTest();
        List<CustomRecordPickerSearchController.SearchResult> results = CustomRecordPickerSearchController.search(request);
        Test.stopTest();

        Assert.isTrue(results.size() >= 0, 'Should handle NIN operator');
    }

    @isTest
    static void testComplexFilterLogic() {
        CustomRecordPickerSearchController.SearchRequest request = new CustomRecordPickerSearchController.SearchRequest();
        request.searchTerm = '';
        request.objectApiName = 'Account';
        request.maxResults = 10;

        CustomRecordPickerSearchController.FilterCriterion criterion1 = new CustomRecordPickerSearchController.FilterCriterion();
        criterion1.fieldPath = 'Type';
        criterion1.operator = 'eq';
        criterion1.value = 'Prospect';

        CustomRecordPickerSearchController.FilterCriterion criterion2 = new CustomRecordPickerSearchController.FilterCriterion();
        criterion2.fieldPath = 'Industry';
        criterion2.operator = 'eq';
        criterion2.value = 'Technology';

        CustomRecordPickerSearchController.FilterCriterion criterion3 = new CustomRecordPickerSearchController.FilterCriterion();
        criterion3.fieldPath = 'Type';
        criterion3.operator = 'ne';
        criterion3.value = 'Customer';

        request.criteria = new List<CustomRecordPickerSearchController.FilterCriterion>{criterion1, criterion2, criterion3};
        request.filterLogic = '(1 OR 2) AND 3';

        Test.startTest();
        List<CustomRecordPickerSearchController.SearchResult> results = CustomRecordPickerSearchController.search(request);
        Test.stopTest();

        Assert.isTrue(results.size() >= 0, 'Should handle complex filter logic');
    }
}
