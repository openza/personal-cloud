import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {prepareCloudRestore} from '../scripts/prepare-cloud-restore.mjs';

// Export order reproduces a child table appearing before its referenced parent.
const exportedSql=`-- Cloud export\r
PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), title TEXT);
INSERT INTO tasks VALUES('task-1','project-1','Owner''s task; नमस्ते ✓');
CREATE TABLE projects(id TEXT PRIMARY KEY, title TEXT);
INSERT INTO projects VALUES('project-1','Recovery rehearsal');
CREATE TABLE events(title TEXT);
INSERT INTO events VALUES('original event');
CREATE UNIQUE INDEX task_title ON tasks(title);
CREATE TRIGGER task_created AFTER INSERT ON tasks BEGIN
  INSERT INTO events VALUES(NEW.title);
  INSERT INTO events VALUES('second; event');
END;
`;

async function fixture(t, sql=exportedSql) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'openza-restore-test-'));
  // Only a unique directory created by this test is removed.
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const input=path.join(directory,'export.sql'), output=path.join(directory,'restore.sql');
  await fs.writeFile(input,sql);
  return {input,output};
}

test('restores forward references, text, indexes and multi-statement triggers without replaying triggers during import',async t=>{
  const {input,output}=await fixture(t);
  const raw=new DatabaseSync(':memory:');
  t.after(()=>raw.close());
  raw.exec('BEGIN');
  assert.throws(()=>raw.exec(exportedSql),/no such table.*projects/);
  raw.exec('ROLLBACK');

  assert.deepEqual(await prepareCloudRestore(input,output),{tables:3,inserts:3,statements:9});
  assert.equal(await fs.readFile(input,'utf8'),exportedSql);
  const restored=new DatabaseSync(':memory:');
  t.after(()=>restored.close());
  restored.exec('BEGIN');
  restored.exec(await fs.readFile(output,'utf8'));
  restored.exec('COMMIT');
  assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(restored.prepare('SELECT title FROM tasks').get().title,"Owner's task; नमस्ते ✓");
  assert.equal(restored.prepare('SELECT count(*) AS n FROM events').get().n,1);
  restored.exec("INSERT INTO tasks VALUES('task-2','project-1','New task')");
  assert.deepEqual(restored.prepare('SELECT title FROM events ORDER BY rowid').all().map(row=>row.title),
    ['original event','New task','second; event']);
  assert.throws(()=>restored.exec("INSERT INTO tasks VALUES('task-3','project-1','New task')"),/UNIQUE constraint/);
});

test('refuses to overwrite the source or an existing output',async t=>{
  const {input,output}=await fixture(t);
  await assert.rejects(prepareCloudRestore(input,input),/separate output/);
  await fs.writeFile(output,'keep this existing backup');
  await assert.rejects(prepareCloudRestore(input,output),{code:'EEXIST'});
  assert.equal(await fs.readFile(input,'utf8'),exportedSql);
  assert.equal(await fs.readFile(output,'utf8'),'keep this existing backup');
});

for(const [name,sql] of [
  ['destructive SQL',exportedSql+'DROP TABLE tasks;'],
  ['additional database',exportedSql+"ATTACH DATABASE 'other.db' AS other;"],
  ['missing schema','PRAGMA defer_foreign_keys=TRUE; INSERT INTO tasks VALUES(1);'],
  ['missing data','PRAGMA defer_foreign_keys=TRUE; CREATE TABLE tasks(id TEXT);'],
  ['missing foreign-key deferral',exportedSql.replace('PRAGMA defer_foreign_keys=TRUE;','')],
  ['duplicate foreign-key deferral',exportedSql+'PRAGMA defer_foreign_keys=TRUE;'],
]) {
  test(`rejects ${name} without producing a restore file`,async t=>{
    const {input,output}=await fixture(t,sql);
    await assert.rejects(prepareCloudRestore(input,output));
    await assert.rejects(fs.stat(output),{code:'ENOENT'});
  });
}
