module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  globalSetup: '<rootDir>/jest/global-setup.ts',
  testMatch: ['**/*.test.ts'],
  clearMocks: true,
};
