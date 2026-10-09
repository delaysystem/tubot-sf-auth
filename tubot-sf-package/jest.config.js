const { jestConfig } = require('@salesforce/sfdx-lwc-jest/config');

module.exports = {
    ...jestConfig,
    moduleNameMapper: {
        ...jestConfig.moduleNameMapper,
        '^c/(.*)$': '<rootDir>/extra-app/main/default/lwc/$1/$1'
    },
    testPathIgnorePatterns: [...jestConfig.testPathIgnorePatterns, '<rootDir>/force-app/']
};
