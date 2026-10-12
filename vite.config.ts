import { defineConfig, build, type Plugin } from 'vite';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, type Target } from './src/manifest';

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };

// background.js and content.js cannot be ES modules with shared chunks:
// content.js is injected with scripting.executeScript({ files }) (classic
// script only) and Firefox's event page is safest as a classic script too.
// So after the HTML pages are built, each of them is bundled separately into
// one self-contained IIFE file.
function extensionScripts(target: Target, outDir: string, watch: boolean): Plugin {
  return {
    name: 'media-grabber:scripts-and-manifest',
    apply: 'build',
    buildStart() {
      // The IIFE bundles are built in closeBundle, outside this module graph —
      // register their sources so `--watch` rebuilds when only they change.
      if (!watch) return;
      for (const dir of ['background', 'content', 'shared']) {
        for (const file of readdirSync(resolve(root, 'src', dir))) this.addWatchFile(resolve(root, 'src', dir, file));
      }
      this.addWatchFile(resolve(root, 'src/manifest.ts'));
    },
    async closeBundle() {
      for (const name of ['background', 'content'] as const) {
        await build({
          configFile: false,
          logLevel: 'warn',
          publicDir: false,
          define: { __TARGET__: JSON.stringify(target) },
          build: {
            outDir,
            emptyOutDir: false,
            minify: false,
            target: 'es2022',
            sourcemap: watch ? 'inline' : false,
            lib: {
              entry: resolve(root, `src/${name}/index.ts`),
              formats: ['iife'],
              name: `MediaGrabber_${name}`,
              fileName: () => `${name}.js`,
            },
          },
        });
      }
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        resolve(outDir, 'manifest.json'),
        JSON.stringify(buildManifest(target, pkg.version), null, 2) + '\n',
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const target: Target = mode === 'firefox' ? 'firefox' : 'chrome';
  const outDir = resolve(root, 'dist', target);
  const watch = process.argv.includes('--watch');
  return {
    root: resolve(root, 'src/ui'),
    publicDir: resolve(root, 'public'),
    base: './',
    define: { __TARGET__: JSON.stringify(target) },
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      target: 'es2022',
      modulePreload: false,
      sourcemap: watch ? 'inline' : false,
      rollupOptions: {
        input: {
          popup: resolve(root, 'src/ui/popup.html'),
          sidepanel: resolve(root, 'src/ui/sidepanel.html'),
          options: resolve(root, 'src/ui/options.html'),
        },
        // Stable names: no cache busting is needed inside an extension, and
        // reviewers (AMO) can diff builds file by file.
        output: {
          entryFileNames: 'assets/[name].js',
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name][extname]',
        },
      },
    },
    plugins: [extensionScripts(target, outDir, watch)],
  };
});
