import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index.ts";
import { hash } from "../src/auth.ts";
import { parseInitialStatus, readInitialStatus, reportInitialStatus } from "../src/initial-sync-status.ts";
const origin="https://personal-cloud.local";
const report=(state="uploading",sequence=1,acknowledged:number|null=0,total:number|null=5)=>JSON.stringify({protocolVersion:1,reportSequence:sequence,state,acknowledged,total});
const request=(method:string,headers:HeadersInit={},body?:string,path="/sync/initial-status")=>worker.fetch(new Request(origin+path,{method,headers,body}),{...env,TEST_MODE:undefined} as unknown as Env);

beforeEach(async()=>{
  await env.DB.batch([env.DB.prepare("DELETE FROM initial_sync_status"),env.DB.prepare("DELETE FROM auth_rate_limits WHERE bucket LIKE 'initial-status:%'"),env.DB.prepare("DELETE FROM devices")]);
});
async function device(id="device.synthetic",canSync=1) {
  const token="synthetic-token-"+id,now=new Date().toISOString(),expires=new Date(Date.now()+600000).toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic desktop','desktop',?2,1,?3)").bind(id,canSync,now),
    env.DB.prepare("INSERT INTO device_access_tokens(token_hash,device_id,created_at,expires_at) VALUES(?1,?2,?3,?4)").bind(await hash(token),id,now,expires),
  ]);return {authorization:`Bearer ${token}`};
}
async function owner() {
  const token=`synthetic-session-${crypto.randomUUID()}`,now=new Date().toISOString(),expires=new Date(Date.now()+600000).toISOString();
  await env.DB.prepare("INSERT OR IGNORE INTO owner_credentials(credential_id,display_name,public_key_jwk,created_at) VALUES('initial-status-owner','Synthetic owner','{}',?1)").bind(now).run();
  await env.DB.prepare("INSERT INTO web_sessions(session_hash,credential_id,csrf_hash,created_at,rotated_at,expires_at,absolute_expires_at) VALUES(?1,'initial-status-owner','unused',?2,?2,?3,?3)").bind(await hash(token),now,expires).run();
  return {cookie:`__Host-openza_session=${token}`};
}

describe("durable initial status auth and validation",()=>{
  it("permits only desktop bearer reporting and owner reads, with no test auth bypass",async()=>{
    const desktop=await device(),web=await owner();
    expect((await request("POST",{},report())).status).toBe(401);
    expect((await request("POST",web,report())).status).toBe(401);
    expect((await request("GET",desktop)).status).toBe(401);
    expect((await request("GET")).status).toBe(401);
    expect((await request("POST",desktop,report())).status).toBe(200);
    const response=await request("GET",web);expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({state:"uploading",devices:[{deviceId:"device.synthetic",acknowledged:0,total:5}]});
    expect((await request("GET",web,undefined,"/sync/initial-status?deviceId=forged")).status).toBe(400);
    await env.DB.prepare("UPDATE devices SET revoked_at=?1").bind(new Date().toISOString()).run();
    expect((await request("POST",desktop,report())).status).toBe(401);
    expect(await readInitialStatus(env.DB)).toMatchObject({state:"unknown",devices:[]});
  });
  it("rejects provider-only access, forged identity, raw errors and invalid counters",async()=>{
    const provider=await device("provider.synthetic",0);expect((await request("POST",provider,report())).status).toBe(401);
    const base=JSON.parse(report());
    for(const changes of [{deviceId:"forged"},{errorCode:"raw private exception",state:"blocked"},{acknowledged:-1},{total:1.5},{acknowledged:6},{acknowledged:null},{state:"complete"},{state:"complete",acknowledged:null,total:null},{protocolVersion:2},{reportSequence:0},{reportSequence:Number.MAX_SAFE_INTEGER+1},{state:"interrupted"}]) {
      expect(()=>parseInitialStatus(JSON.stringify({...base,...changes}))).toThrow();
    }
    expect(parseInitialStatus(report("uploading",1,null,null))).toMatchObject({acknowledged:null,total:null});
    expect(parseInitialStatus(JSON.stringify({...base,state:"blocked",errorCode:"offline"}))).toMatchObject({errorCode:"offline"});
    expect(()=>parseInitialStatus(" ".repeat(2049)+report())).toThrow();
  });
  it("preserves newer reports under repeated/out-of-order/concurrent writes and terminal completion",async()=>{
    await device();
    await reportInitialStatus(env.DB,"device.synthetic",report("uploading",2,2));
    expect(await reportInitialStatus(env.DB,"device.synthetic",report("uploading",1,0))).toMatchObject({accepted:false});
    expect(await reportInitialStatus(env.DB,"device.synthetic",report("blocked",2,2))).toMatchObject({accepted:false});
    await Promise.all([reportInitialStatus(env.DB,"device.synthetic",report("uploading",3,3)),reportInitialStatus(env.DB,"device.synthetic",report("complete",4,5))]);
    expect(await reportInitialStatus(env.DB,"device.synthetic",report("uploading",5,5))).toMatchObject({accepted:false});
    expect(await readInitialStatus(env.DB)).toMatchObject({state:"complete",devices:[{acknowledged:5,total:5}]});
    const row=await env.DB.prepare("SELECT report_sequence FROM initial_sync_status").first();expect(row).toEqual({report_sequence:4});
  });
  it("rate limits authenticated telemetry without altering task tables",async()=>{
    const desktop=await device();
    for(let i=1;i<=8;i++) expect((await request("POST",desktop,report("uploading",i))).status).toBe(200);
    expect((await request("POST",desktop,report("uploading",9))).status).toBe(429);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM tasks").first()).toEqual({count:0});
  });
});
describe("initial status multi-device and staleness",()=>{
  it("does not let complete or unknown devices hide an uploader, and measures heartbeat with server time",async()=>{
    await device("a");await device("b");await device("c");
    await reportInitialStatus(env.DB,"a",report("complete",1,0,0));
    expect(await readInitialStatus(env.DB)).toMatchObject({state:"unknown"});
    await reportInitialStatus(env.DB,"b",report());
    expect(await readInitialStatus(env.DB)).toMatchObject({state:"uploading"});
    const time="2026-10-12T00:00:00.000Z";await env.DB.prepare("UPDATE initial_sync_status SET updated_at=?1 WHERE device_id='b'").bind(time).run();
    expect(await readInitialStatus(env.DB,new Date("2026-10-12T00:01:59.999Z"))).toMatchObject({state:"uploading"});
    expect(await readInitialStatus(env.DB,new Date("2026-10-12T00:02:00.000Z"))).toMatchObject({state:"interrupted"});
    await reportInitialStatus(env.DB,"b",report("blocked",2));expect(await readInitialStatus(env.DB)).toMatchObject({state:"blocked"});
    await reportInitialStatus(env.DB,"b",report("complete",3,5));expect(await readInitialStatus(env.DB)).toMatchObject({state:"unknown"});
    await reportInitialStatus(env.DB,"c",report("complete",1,0,0));expect(await readInitialStatus(env.DB)).toMatchObject({state:"complete"});
    expect(await readInitialStatus(env.DB,new Date("2030-01-01"))).toMatchObject({state:"complete"});
    await env.DB.prepare("DELETE FROM devices WHERE device_id='a'").run();
    expect(await env.DB.prepare("SELECT * FROM initial_sync_status WHERE device_id='a'").first()).toBeNull();
  });
});
