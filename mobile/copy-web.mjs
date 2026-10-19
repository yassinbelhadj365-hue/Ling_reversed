// Copies the web app (the repository root) into mobile/www, which Capacitor packages.
// The web app has no build step, so this is a plain copy.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const www = join(here, 'www');

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
for (const f of ['index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg', 'sw.js', 'js', 'data']) {
  cpSync(join(root, f), join(www, f), { recursive: true });
}
console.log(`Copied the web app into ${www}`);
