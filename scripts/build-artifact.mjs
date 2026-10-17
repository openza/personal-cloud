import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { extname, join, posix } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(version)) {
  throw new Error("Usage: npm run build:artifact -- <version>");
}

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist");
const bundle = join(dist, "bundle");
const output = join(dist, `openza-personal-cloud-${version}`);
await rm(bundle, { recursive: true, force: true });
await rm(output, { recursive: true, force: true });
await mkdir(bundle, { recursive: true });

const wranglerRoot = join(root, "node_modules", "wrangler");
const wranglerPackage = JSON.parse(await readFile(join(wranglerRoot, "package.json"), "utf8"));
const wrangler = spawnSync(process.execPath,
  [join(wranglerRoot, wranglerPackage.bin.wrangler), "deploy", "--dry-run", "--outdir", bundle], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, WRANGLER_LOG_PATH: join(tmpdir(), "openza-personal-cloud-artifact-wrangler.log") },
  });
if (wrangler.status !== 0) throw new Error("Wrangler could not build the Personal Cloud Worker.");

await mkdir(join(output, "assets"), { recursive: true });
await mkdir(join(output, "migrations"), { recursive: true });
await cp(join(bundle, "index.js"), join(output, "worker.js"));
for (const name of await readdir(join(root, "public")))
  await cp(join(root, "public", name), join(output, "assets", name), { recursive: true });
for (const name of (await readdir(join(root, "migrations"))).filter(name => name.endsWith(".sql")).sort()) {
  // Migration hashes are persisted in D1. Windows checkout line endings must
  // not make an unchanged migration look different from a Linux release.
  const sql = (await readFile(join(root, "migrations", name), "utf8")).replaceAll("\r\n", "\n");
  await writeFile(join(output, "migrations", name), sql, "utf8");
}

const configuration = JSON.parse(await readFile(join(root, "wrangler.jsonc"), "utf8"));
const files = [];
for (const directory of ["assets", "migrations"]) {
  for (const name of (await publicFiles(join(output, directory))).sort()) {
    const file = posix.join(directory, name);
    const content = await readFile(join(output, file));
    files.push({ file, size: content.byteLength, sha256: sha256(content) });
  }
}
const worker = await readFile(join(output, "worker.js"));
const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };
const manifest = {
  formatVersion: 1,
  artifactVersion: version,
  compatibilityDate: configuration.compatibility_date,
  worker: { file: "worker.js", size: worker.byteLength, sha256: sha256(worker) },
  assets: files.filter(item => item.file.startsWith("assets/")).map(item => ({
    ...item,
    path: `/${posix.relative("assets", item.file)}`,
    contentType: contentTypes[extname(item.file)] ?? "application/octet-stream",
  })),
  migrations: files.filter(item => item.file.startsWith("migrations/")),
};
await writeFile(join(output, "artifact-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`Built ${output}\n`);

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function publicFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const relative = posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await publicFiles(directory, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}
