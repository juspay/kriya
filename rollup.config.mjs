import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import dts from 'rollup-plugin-dts';

const production = !process.env.ROLLUP_WATCH;

const baseConfig = {
  input: 'src/index.ts',
  external: ['react', 'react-final-form', 'html2canvas'],
};

const buildConfig = {
  ...baseConfig,
  output: [
    {
      file: 'dist/index.js',
      format: 'cjs',
      exports: 'named',
      sourcemap: true,
    },
    {
      file: 'dist/index.esm.js',
      format: 'es',
      exports: 'named',
      sourcemap: true,
    },
    {
      file: 'dist/index.umd.js',
      format: 'umd',
      name: 'WebAutomata',
      exports: 'named',
      sourcemap: true,
      globals: {
        'react': 'React',
        'react-final-form': 'ReactFinalForm',
        'html2canvas': 'html2canvas',
      },
    },
  ],
  plugins: [
    resolve({
      browser: true,
      preferBuiltins: false,
    }),
    commonjs(),
    typescript({
      tsconfig: './tsconfig.json',
      declaration: false,
      declarationMap: false,
    }),
    production && terser({
      compress: {
        drop_console: true,
        drop_debugger: true,
      },
      mangle: {
        reserved: ['WebAutomata'],
      },
    }),
  ].filter(Boolean),
};

const typesConfig = {
  ...baseConfig,
  output: {
    file: 'dist/index.d.ts',
    format: 'es',
  },
  plugins: [
    dts(),
  ],
};

export default [buildConfig, typesConfig];