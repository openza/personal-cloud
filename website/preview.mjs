import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('./dist/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.txt': 'text/plain' };
createServer(async (req, res) => {
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400).end(); return; }
  const file = resolve(root, '.' + path + (path.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(resolve(root) + sep)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': types['.html'] });
    res.end(await readFile(root + '404.html'));
  }
}).listen(8799, '127.0.0.1', () => console.log('Website preview: http://127.0.0.1:8799/'));
