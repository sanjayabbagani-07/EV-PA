// Portable test entrypoint (no shell globbing; works on Node 20+ on any OS): `npm test`
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
for (const f of readdirSync(dir).filter((n) => n.endsWith('.test.mjs')).sort()) {
  await import(pathToFileURL(join(dir, f)).href);
}
