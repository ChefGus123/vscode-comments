module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^vscode$': '<rootDir>/test/__mocks__/vscode.ts',
  },
  clearMocks: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/types.ts'],
  coverageDirectory: '<rootDir>/coverage',
  coverageProvider: 'babel',
  coverageThreshold: {
    global: {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
};
