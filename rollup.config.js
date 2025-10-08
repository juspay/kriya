import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import alias from '@rollup/plugin-alias';
import { fileURLToPath } from 'url';
import path from 'path';
import dts from 'rollup-plugin-dts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const production = !process.env.ROLLUP_WATCH;

const baseConfig = {
  input: 'src/index.ts',
  external: ['html2canvas'],
  plugins: [
    alias({
      entries: [
        { find: '@', replacement: path.resolve(__dirname, 'src') }
      ]
    }),
    resolve({
      browser: true,
      preferBuiltins: false
    }),
    commonjs(),
    typescript({
      tsconfig: './tsconfig.json',
      declaration: false,
      declarationMap: false
    })
  ]
};

export default [
  // ES modules build
  {
    ...baseConfig,
    output: {
      file: 'dist/index.esm.js',
      format: 'es',
      sourcemap: true
    },
    plugins: [
      ...baseConfig.plugins,
      production && terser()
    ].filter(Boolean)
  },
  
  // CommonJS build
  {
    ...baseConfig,
    output: {
      file: 'dist/index.js',
      format: 'cjs',
      sourcemap: true,
      exports: 'named'
    },
    plugins: [
      ...baseConfig.plugins,
      production && terser()
    ].filter(Boolean)
  },
  
  // TypeScript declarations
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/index.d.ts',
      format: 'es'
    },
    plugins: [dts()],
    external: ['html2canvas']
  }
];
