// Bundles the Electron main and preload scripts (CommonJS, Node target).
import { build } from 'esbuild';

const feed = process.env.ADVENCE_FEED_URL ?? '';  // set by the release build (D-24)
const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron', 'bufferutil', 'utf-8-validate'], sourcemap: false, minify: false, logLevel: 'info' };
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist-electron/main.cjs', define: { 'process.env.ADVENCE_FEED_URL_BUILD': JSON.stringify(feed) } });
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist-electron/preload.cjs' });
