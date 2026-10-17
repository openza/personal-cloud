import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readD1Migrations} from '@cloudflare/vitest-plugin';
import {taskJson,projectJson} from '../src/workspace-records.ts';

test('real SQLite enforces D1 length/argument limits with compound rollback',async()=>{
 const input={migrations:await readD1Migrations('migrations'),taskJson,projectJson};
 const script=String.raw`
import json,sqlite3,sys
data=json.load(sys.stdin)
db=sqlite3.connect(':memory:',isolation_level=None)
db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH,2000000)
db.setlimit(sqlite3.SQLITE_LIMIT_FUNCTION_ARG,32)
for migration in data['migrations']:
 for query in migration['queries']: db.execute(query)
db.execute("INSERT INTO projects(id,space_id,name) VALUES('project.limit','space_default','Synthetic')")
payload="json_object('spaces',json('[]'),'projects',json((SELECT json_group_array(json(record)) FROM (SELECT "+data['projectJson']+" AS record FROM projects p))),'tasks',json((SELECT json_group_array(json(record)) FROM (SELECT "+data['taskJson']+" AS record FROM tasks t))),'scopes',json('[]'),'catalog',json('[]'),'intents',json('[]'),'routes',json('[]'))"
results=[]
for count in [300,405,420,500]:
 db.execute('DELETE FROM tasks')
 db.executemany("INSERT INTO tasks(id,product,space_id,project_id,title,completion_state,workflow_status,created_at,entity_version,created_by_mutation_id,notes) VALUES(?,'tasks','space_default','project.limit','Synthetic','open','inbox','2026-10-15T00:00:00.000Z',1,?,?)",[(f'task.limit.{n}',f'mutation.limit.{n}','x'*4096) for n in range(count)])
 sample=json.loads(db.execute('SELECT '+data['taskJson']+' FROM tasks t LIMIT 1').fetchone()[0])
 assert len(sample)==25 and sample['source'] is None and sample['deadlineAt'] is None
 db.execute('BEGIN')
 try:
  db.execute("UPDATE tasks SET project_id=NULL,workflow_status='inbox',entity_version=entity_version+1")
  db.execute("INSERT INTO changes(change_seq,protocol_version,product,mutation_id,operation,entity_kind,entity_id,entity_version,payload_json,server_accepted_at) SELECT 1,1,'tasks','mutation.limit.change','workspace.changed','workspace','project.limit',2,"+payload+",'2026-10-15T00:00:00.000Z'")
  size=db.execute('SELECT length(CAST(payload_json AS BLOB)) FROM changes').fetchone()[0]
  assert size<=1900000
  outcome='accepted'
 except sqlite3.Error as error:
  outcome='SQLITE_TOOBIG' if error.sqlite_errorcode==sqlite3.SQLITE_TOOBIG else str(error)
  assert outcome in ('SQLITE_TOOBIG','workspace response too large'),outcome
 finally: db.execute('ROLLBACK')
 assert db.execute("SELECT count(*) FROM tasks WHERE project_id='project.limit' AND entity_version=1").fetchone()[0]==count
 assert db.execute('SELECT count(*) FROM changes').fetchone()[0]==0
 results.append({'tasks':count,'outcome':outcome})
print(json.dumps(results))
assert any(x['outcome']=='accepted' for x in results)
assert any(x['outcome']=='workspace response too large' for x in results)
assert any(x['outcome']=='SQLITE_TOOBIG' for x in results)
`;
 const result=spawnSync('uv',['run','--no-project','--no-python-downloads','--python',process.platform==='win32'?'3':'/usr/bin/python3','python','-c',script],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:2*1024*1024});
 assert.equal(result.status,0,result.stderr);const evidence=JSON.parse(result.stdout);assert.equal(evidence.length,4);process.stdout.write(JSON.stringify(evidence)+'\n');
});
