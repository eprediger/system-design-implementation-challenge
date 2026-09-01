module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  globalSetup: '<rootDir>/jest/global-setup.ts',
  testMatch: ['**/*.test.ts'],
  clearMocks: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts'],
  coverageReporters: ['text-summary', 'lcov'],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: {
      statements: 80,
      branches: 75,
      functions: 65,
      lines: 80,
    },
  },
};
