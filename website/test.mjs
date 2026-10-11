import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const dist = fileURLToPath(new URL('./dist/', import.meta.url));
for (const path of ['index.html', 'personal-cloud/index.html', 'privacy/index.html', '404.html']) {
  test(`${path}: accessible static shell, local links and no tracking`, async () => {
    const html = await readFile(dist + path, 'utf8');
    assert.match(html, /<html lang="en">/);
    assert.match(html, /name="viewport"/);
    assert.equal((html.match(/<h1>/g) || []).length, 1);
    assert.match(html, /href="#main"/);
    assert.match(html, /<main id="main">/);
    assert.doesNotMatch(html, /<script|<iframe|<form|on(?:click|load)=/i);
    assert.doesNotMatch(html, /https:\/\/github\.com\/openza\/personal-cloud/, 'Do not advertise inaccessible private-repo links');
    for (const [, url] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (!url.startsWith('/')) continue;
      const pathname = url.split('#')[0];
      const target = dist + pathname.slice(1) + (pathname.endsWith('/') ? 'index.html' : '');
      assert.ok((await stat(target)).isFile(), `Missing local asset/link: ${url}`);
    }
    for (const [, src] of html.matchAll(/src="([^"]+)"/g)) assert.ok(src.startsWith('/'));
  });
}
test('privacy and onboarding limitations remain explicit', async () => {
  const cloud = await readFile(dist + 'personal-cloud/index.html', 'utf8');
  const privacy = await readFile(dist + 'privacy/index.html', 'utf8');
  assert.match(cloud, /Public onboarding is not open yet/);
  assert.match(cloud, /OAuth client is currently private/);
  assert.match(privacy, /not<\/strong> provide end-to-end encryption/);
  assert.match(privacy, /Signing out does not erase/);
  const headers = await readFile(dist + '_headers', 'utf8');
  assert.match(headers, /frame-ancestors 'none'/);
  assert.match(headers, /default-src 'none'/);
});
