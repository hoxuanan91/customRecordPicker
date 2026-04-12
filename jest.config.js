const { jestConfig } = require("@salesforce/sfdx-lwc-jest/config");

module.exports = {
    ...jestConfig,
    modulePathIgnorePatterns: ["<rootDir>/.localdevserver"],
    testMatch: [
        "**/force-app/main/default/lwc/**/__tests__/**/*.test.js",
    ],
    moduleNameMapper: {
        ...jestConfig.moduleNameMapper,
        "^lightning/flowSupport$": "<rootDir>/__mocks__/lightning/flowSupport.js",
    },
    coverageDirectory: ".coverage",
    collectCoverageFrom: [
        "force-app/main/default/lwc/**/*.js",
        "!force-app/main/default/lwc/**/__tests__/**",
    ],
};
