/** @type {import('jest').Config} */
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
      {
        tsconfig: {
          target: 'ES2020',
          module: 'commonjs',
          rootDir: '.',
          incremental: false,
          esModuleInterop: true,
          strict: true,
          noUncheckedIndexedAccess: true,
          types: ['jest', 'node'],
        },
      },
    ],
  },
  clearMocks: true,
};
