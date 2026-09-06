import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.resolve(__dirname, '../../web/static/vendor/monaco');

console.log('[Editor V2 Builder] Outdir:', outdir);
if (!fs.existsSync(outdir)) {
  fs.mkdirSync(outdir, { recursive: true });
}

// 1. Bundle main editor bundle
console.log('[Editor V2 Builder] Bundling main editor...');
const monacoResolvePlugin = {
  name: 'monaco-resolve',
  setup(build) {
    build.onResolve({ filter: /^monaco-editor\/esm\/vs\// }, args => {
      const rel = args.path.replace(/^monaco-editor\/esm\/vs\//, '');
      const absPath = path.resolve(__dirname, 'node_modules/monaco-editor/esm/vs', rel);
      return { path: absPath };
    });
  }
};

await esbuild.build({
  entryPoints: [{ in: path.resolve(__dirname, 'monaco-entry.js'), out: 'ed2monaco' }],
  bundle: true,
  format: 'iife',
  globalName: 'Ed2Monaco',
  target: 'es2022',
  minify: true,
  splitting: false,
  sourcemap: false,
  outdir: outdir,
  plugins: [monacoResolvePlugin],
  loader: {
    '.ttf': 'file',
  },
  assetNames: 'assets/[name]-[hash]',
  logLevel: 'info',
});

// 2. Bundle editor worker
console.log('[Editor V2 Builder] Bundling editor worker...');
await esbuild.build({
  entryPoints: [{ in: path.resolve(__dirname, 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js'), out: 'editor.worker' }],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: true,
  splitting: false,
  sourcemap: false,
  outdir: outdir,
  logLevel: 'info',
});

// 3. Copy License and ThirdPartyNotices
console.log('[Editor V2 Builder] Copying LICENSE & ThirdPartyNotices...');
const monacoDir = path.resolve(__dirname, 'node_modules/monaco-editor');
for (const file of ['LICENSE', 'ThirdPartyNotices.txt']) {
  const src = path.join(monacoDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(outdir, file));
    console.log(`Copied ${file} to ${outdir}`);
  }
}

console.log('[Editor V2 Builder] Finished successfully!');
