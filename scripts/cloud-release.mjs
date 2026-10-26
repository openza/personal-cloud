// Builds and signs the metadata of a Personal Cloud release. See docs/cloud-releases.md.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const desktopVersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+$/;

export function validateConfig(config) {
  if (!Number.isSafeInteger(config?.releaseNumber) || config.releaseNumber < 1)
    throw new Error("cloud-release.config.json needs a positive integer releaseNumber.");
  if (typeof config.minDesktopVersion !== "string" || !desktopVersionPattern.test(config.minDesktopVersion))
    throw new Error("cloud-release.config.json needs minDesktopVersion as MAJOR.MINOR.PATCH.");
  return config;
}

export async function createReleaseMetadata({ artifactVersion, artifactDirectory, archivePath, config, sourceRevision }) {
  if (!versionPattern.test(artifactVersion ?? "") || artifactVersion.length > 128) throw new Error("Invalid artifact version.");
  if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? "")) throw new Error("A full 40-character source revision is required.");
  validateConfig(config);
  const manifestBytes = await readFile(join(artifactDirectory, "artifact-manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  if (manifest.formatVersion !== 1 || manifest.artifactVersion !== artifactVersion)
    throw new Error("The artifact manifest does not match the release version.");
  const archive = await readFile(archivePath);
  const expectedArchive = `openza-personal-cloud-${artifactVersion}.zip`;
  if (basename(archivePath) !== expectedArchive) throw new Error(`The archive must be named ${expectedArchive}.`);
  return {
    formatVersion: 1,
    product: "openza-personal-cloud",
    artifactVersion,
    releaseNumber: config.releaseNumber,
    minDesktopVersion: config.minDesktopVersion,
    sourceRevision,
    manifestSha256: sha256(manifestBytes),
    archive: { file: expectedArchive, size: (await stat(archivePath)).size, sha256: sha256(archive) },
  };
}

// The signature covers the exact metadata bytes Desktop downloads.
export function serializeMetadata(metadata) {
  return Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

export function signMetadata(bytes, privateKeyPem) {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("The release signing key must be an ECDSA P-256 private key.");
  return sign("sha256", bytes, { key, dsaEncoding: "der" }).toString("base64");
}

export function verifyMetadata(bytes, signatureBase64, publicKeyPem) {
  return verify("sha256", bytes, { key: createPublicKey(publicKeyPem), dsaEncoding: "der" }, Buffer.from(signatureBase64, "base64"));
}

async function main([artifactVersion, artifactDirectory, archivePath, outputDirectory]) {
  if (!artifactVersion || !artifactDirectory || !archivePath || !outputDirectory)
    throw new Error("Usage: node scripts/cloud-release.mjs <artifactVersion> <artifactDirectory> <archive.zip> <outputDirectory>");
  const privateKey = process.env.CLOUD_RELEASE_SIGNING_KEY;
  if (!privateKey) throw new Error("CLOUD_RELEASE_SIGNING_KEY is not set.");
  const config = JSON.parse(await readFile(new URL("../cloud-release.config.json", import.meta.url), "utf8"));
  const metadata = await createReleaseMetadata({ artifactVersion, artifactDirectory, archivePath, config, sourceRevision: process.env.GITHUB_SHA });
  const bytes = serializeMetadata(metadata);
  await writeFile(join(outputDirectory, "cloud-release.json"), bytes);
  await writeFile(join(outputDirectory, "cloud-release.json.sig"), `${signMetadata(bytes, privateKey)}\n`);
  console.log(`Signed ${metadata.artifactVersion} (release ${metadata.releaseNumber}, Desktop ${metadata.minDesktopVersion}+).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  await main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
