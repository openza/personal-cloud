import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReleaseMetadata, serializeMetadata, signMetadata, validateConfig, validateReleaseNumber, verifyMetadata } from "../scripts/cloud-release.mjs";

const revision = "a".repeat(40);
async function fixture(version = "0.1.0-preview.11") {
  const root = await mkdtemp(join(tmpdir(), "cloud-release-"));
  const artifact = join(root, "artifact");
  await mkdir(artifact);
  await writeFile(join(artifact, "artifact-manifest.json"), JSON.stringify({ formatVersion: 1, artifactVersion: version }));
  const archive = join(root, `openza-personal-cloud-${version}.zip`);
  await writeFile(archive, "zip bytes");
  return { artifact, archive };
}
const keys = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privatePem: privateKey.export({ type: "pkcs8", format: "pem" }), publicPem: publicKey.export({ type: "spki", format: "pem" }) };
};

test("release metadata records version, ordering, minimum Desktop and exact hashes", async () => {
  const { artifact, archive } = await fixture();
  const metadata = await createReleaseMetadata({ artifactVersion: "0.1.0-preview.11", artifactDirectory: artifact, archivePath: archive,
    config: { releaseNumber: 11, minDesktopVersion: "1.3.0" }, sourceRevision: revision });
  assert.equal(metadata.product, "openza-personal-cloud");
  assert.equal(metadata.releaseNumber, 11);
  assert.equal(metadata.minDesktopVersion, "1.3.0");
  assert.equal(metadata.archive.file, "openza-personal-cloud-0.1.0-preview.11.zip");
  assert.equal(metadata.archive.size, 9);
  assert.match(metadata.manifestSha256, /^[a-f0-9]{64}$/);
});

test("metadata must match the artifact, archive name and a full source revision", async () => {
  const { artifact, archive } = await fixture("0.1.0-preview.10");
  const base = { artifactVersion: "0.1.0-preview.11", artifactDirectory: artifact, archivePath: archive, config: { releaseNumber: 11, minDesktopVersion: "1.3.0" }, sourceRevision: revision };
  await assert.rejects(createReleaseMetadata(base), /does not match/);
  await assert.rejects(createReleaseMetadata({ ...base, artifactVersion: "0.1.0-preview.10", sourceRevision: "abc" }), /source revision/);
  const renamed = join(artifact, "..", "release.zip");
  await writeFile(renamed, "zip bytes");
  await assert.rejects(createReleaseMetadata({ ...base, artifactVersion: "0.1.0-preview.10", archivePath: renamed }), /archive must be named/);
});

test("config requires a positive release number and a MAJOR.MINOR.PATCH minimum Desktop", () => {
  assert.throws(() => validateConfig({ releaseNumber: 0, minDesktopVersion: "1.3.0" }), /releaseNumber/);
  assert.throws(() => validateConfig({ releaseNumber: 11, minDesktopVersion: "1.3" }), /minDesktopVersion/);
  assert.doesNotThrow(() => validateConfig({ releaseNumber: 11, minDesktopVersion: "1.3.0" }));
});

test("signatures verify only for the exact bytes and the matching public key", () => {
  const { privatePem, publicPem } = keys();
  const bytes = serializeMetadata({ artifactVersion: "0.1.0-preview.11", releaseNumber: 11 });
  const signature = signMetadata(bytes, privatePem);
  assert.equal(verifyMetadata(bytes, signature, publicPem), true);
  assert.equal(verifyMetadata(serializeMetadata({ artifactVersion: "0.1.0-preview.11", releaseNumber: 12 }), signature, publicPem), false);
  assert.equal(verifyMetadata(bytes, signature, keys().publicPem), false);
});

test("only ECDSA P-256 keys can sign releases", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  assert.throws(() => signMetadata(Buffer.from("x"), privateKey.export({ type: "pkcs8", format: "pem" })), /P-256/);
});

test("release numbers must increase across releases", () => {
  assert.doesNotThrow(() => validateReleaseNumber(11, []));
  assert.doesNotThrow(() => validateReleaseNumber(12, [10, 11]));
  assert.throws(() => validateReleaseNumber(11, [11]), /greater/);
  assert.throws(() => validateReleaseNumber(10, [11]), /greater/);
});

test("the committed release config is valid", async () => {
  validateConfig(JSON.parse(await readFile(new URL("../cloud-release.config.json", import.meta.url), "utf8")));
});
