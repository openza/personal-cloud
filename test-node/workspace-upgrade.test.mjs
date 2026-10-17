import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readD1Migrations} from '@cloudflare/vitest-plugin';

test('populated schema 22 upgrades through the current migrations without losing receipts or foreign keys',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',compatibilityDate:'2026-09-13',d1Databases:{DB:'populated-upgrade'},host:'127.0.0.1',port:0}));
 try {
  const {DB:db}=await mf.getBindings(),migrations=await readD1Migrations('migrations');
  for(const migration of migrations.slice(0,22))await db.batch(migration.queries.map(query=>db.prepare(query)));
  await db.batch([
   db.prepare("INSERT INTO changes VALUES(1,1,'tasks','upgrade.created','task.created','task','upgrade.task',1,'{}','2026-10-17T00:00:00Z')"),
   db.prepare("INSERT INTO mutation_receipts VALUES('upgrade.created',1,'tasks','{}','hash','upgrade.task',1,1,'2026-10-17T00:00:00Z')"),
   db.prepare("INSERT INTO entity_version_claims VALUES('upgrade.task',1,'upgrade.updated')")
  ]);
  for(const migration of migrations.slice(22))await db.batch(migration.queries.map(query=>db.prepare(query)));
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  assert.equal((await db.prepare("SELECT change_seq FROM mutation_receipts WHERE mutation_id='upgrade.created'").first()).change_seq,1);
  assert.equal((await db.prepare("SELECT mutation_id FROM entity_version_claims WHERE entity_id='upgrade.task'").first()).mutation_id,'upgrade.updated');
  await assert.rejects(db.prepare("INSERT INTO mutation_receipts VALUES('upgrade.invalid',1,'tasks','{}','hash','upgrade.task',2,999,'2026-10-17T00:00:00Z')").run(),/FOREIGN KEY constraint failed/);
  await assert.rejects(db.prepare("UPDATE mutation_receipts SET canonical_hash='changed' WHERE mutation_id='upgrade.created'").run(),/mutation receipts are immutable/);
 }finally{await mf.dispose();}
});
