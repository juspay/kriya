module.exports = {
  testEnvironment: 'jsdom',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^html2canvas$': require.resolve('html2canvas'),
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      { tsconfig: { module: 'CommonJS', rootDir: '.', incremental: false } },
    ],
  },
  clearMocks: true,
};
