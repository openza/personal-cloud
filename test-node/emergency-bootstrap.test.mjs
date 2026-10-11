import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {beginOwnerBootstrap,finishOwnerBootstrap} from '../src/auth.ts';

test('real emergency SQL preserves history and permits replacement owner bootstrap',async()=>{
  const sql=new DatabaseSync(':memory:');
  for(const file of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())sql.exec(readFileSync('migrations/'+file,'utf8'));
  const DB={prepare(query){let values=[];return {bind(...v){values=v;return this;},async first(){return sql.prepare(query).get(...values)??null;},async all(){return {results:sql.prepare(query).all(...values)};},async run(){const result=sql.prepare(query).run(...values);return {meta:{changes:Number(result.changes)}};}};},async batch(statements){sql.exec('BEGIN IMMEDIATE');try{const results=[];for(const s of statements)results.push(await s.run());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}}};
  const grant='replacement-owner-bootstrap-grant-public-test';
  const origin='https://personal-cloud.local';
  const env={DB,INSTANCE_ID:'instance_test',OWNER_BOOTSTRAP_GRANT:grant};
  async function bootstrap(){
    const request=new Request(origin+'/auth/bootstrap/begin',{method:'POST'});
    const options=await (await beginOwnerBootstrap(request,env,JSON.stringify({grant,displayName:'Test owner'}))).json();
    const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
    const jwk=await crypto.subtle.exportKey('jwk',keys.publicKey);
    const idBytes=crypto.getRandomValues(new Uint8Array(32));
    const rpHash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(options.rp.id)));
    const cose=map([[1,2],[3,-7],[-1,1],[-2,decode(jwk.x)],[-3,decode(jwk.y)]]);
    const authData=concat(rpHash,Uint8Array.of(0x45),new Uint8Array(4),new Uint8Array(16),Uint8Array.of(0,idBytes.length),idBytes,cose);
    const credential={id:encode(idBytes),clientDataJSON:encode(new TextEncoder().encode(JSON.stringify({type:'webauthn.create',challenge:options.challenge,origin}))),attestationObject:encode(map([['fmt','none'],['attStmt',new Map()],['authData',authData]]))};
    const result=await finishOwnerBootstrap(new Request(origin+'/auth/bootstrap/finish',{method:'POST'}),env,JSON.stringify({grant,displayName:'Test owner',challenge:options.challenge,credential}));
    assert.equal(result.status,200);assert.equal((await result.json()).outcome,'initialized');
  }
  await bootstrap();
  const prepared=spawnSync(process.execPath,['scripts/prepare-owner-rebootstrap.mjs'],{input:grant+'\n',encoding:'utf8'});
  assert.equal(prepared.status,0,prepared.stderr);
  sql.exec(prepared.stdout);
  assert.equal(sql.prepare('SELECT COUNT(*) AS count FROM owner_credentials WHERE revoked_at IS NULL').get().count,0);
  await bootstrap();
  assert.equal(sql.prepare('SELECT COUNT(*) AS count FROM owner_credentials WHERE revoked_at IS NULL').get().count,1);
  assert.deepEqual(sql.prepare('SELECT version,consumed_at FROM recovery_codes ORDER BY version').all().map(r=>({version:r.version,consumed:!!r.consumed_at})),[{version:1,consumed:true},{version:2,consumed:false}]);
  assert.equal(sql.prepare('SELECT COUNT(*) AS count FROM emergency_rebootstrap_audit').get().count,1);
  sql.close();
});
function concat(...values){const result=new Uint8Array(values.reduce((n,v)=>n+v.length,0));let offset=0;for(const v of values){result.set(v,offset);offset+=v.length;}return result;}
const encode=v=>Buffer.from(v).toString('base64url');
const decode=v=>new Uint8Array(Buffer.from(v,'base64url'));
function head(major,length){return length<24?Uint8Array.of(major<<5|length):length<256?Uint8Array.of(major<<5|24,length):Uint8Array.of(major<<5|25,length>>8,length&255);}
function map(entries){return concat(head(5,entries.length),...entries.flatMap(([k,v])=>[cbor(k),cbor(v)]));}
function cbor(value){if(value instanceof Uint8Array)return concat(head(2,value.length),value);if(value instanceof Map)return map([...value]);if(typeof value==='string'){const bytes=new TextEncoder().encode(value);return concat(head(3,bytes.length),bytes);}return value>=0?head(0,value):head(1,-1-value);}
