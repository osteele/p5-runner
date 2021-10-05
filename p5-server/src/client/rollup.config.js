import { babel } from '@rollup/plugin-babel';
import { terser } from "rollup-plugin-terser";

let production = !process.env.BUILD || process.env.BUILD === 'production';
const plugins = [babel({ babelHelpers: 'bundled' }), production && terser()];

export default [
  {
    input: './src/client/console-relay.js',
    output: {
      file: './src/server/static/console-relay.min.js',
      format: 'iife',
      strict: false,
    },
    plugins,
  },
  {
    input: './src/client/iframe-manager.js',
    output: {
      file: './src/server/static/iframe-manager.min.js',
      format: 'iife',
    },
    plugins,
  }
]
