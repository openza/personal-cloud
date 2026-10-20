import {ContractError,parseStrictJson} from './protocol.ts';

export const catchupStatusCapability={protocolVersion:1,path:'/sync/catchup-status',staleAfterSeconds:900} as const;
export const webFanoutDailyCredits=12000;
export const catchupWebFanoutDailyCredits=1000;
export function parseCatchupReport(raw:string){
 if(new TextEncoder().encode(raw).byteLength>2048)throw new ContractError('invalid_request','Invalid catch-up report.');
 const report=parseStrictJson(raw);
 if(!report||typeof report!=='object'||Array.isArray(report)||Object.keys(report).sort().join(',')!=='pending,protocolVersion,reportSequence,state'||report.protocolVersion!==1||typeof report.reportSequence!=='number'||!Number.isSafeInteger(report.reportSequence)||report.reportSequence<1||typeof report.pending!=='number'||!Number.isSafeInteger(report.pending)||report.pending<0||typeof report.state!=='string'||!['catching_up','idle'].includes(report.state))throw new ContractError('invalid_request','Invalid catch-up report.');
 return report as {protocolVersion:1;reportSequence:number;state:'catching_up'|'idle';pending:number};
}
export async function reportCatchupStatus(db:D1Database,deviceId:string,raw:string,now=new Date()){
 const report=parseCatchupReport(raw),at=now.toISOString();
 const result=await db.prepare(`INSERT INTO sync_catchup_status(device_id,report_sequence,state,pending,finished_at,updated_at)
 SELECT device_id,?2,?3,?4,CASE WHEN ?3='idle' THEN ?5 ELSE NULL END,?5 FROM devices
 WHERE device_id=?1 AND revoked_at IS NULL AND kind='desktop' AND can_sync=1
 ON CONFLICT(device_id) DO UPDATE SET report_sequence=excluded.report_sequence,state=excluded.state,pending=excluded.pending,
 finished_at=CASE WHEN excluded.state!='idle' THEN NULL WHEN sync_catchup_status.state='idle' THEN sync_catchup_status.finished_at ELSE excluded.updated_at END,
 updated_at=excluded.updated_at WHERE excluded.report_sequence>sync_catchup_status.report_sequence`).bind(deviceId,report.reportSequence,report.state,report.pending,at).run();
 const current=await db.prepare('SELECT report_sequence,updated_at FROM sync_catchup_status WHERE device_id=?1').bind(deviceId).first<{report_sequence:number;updated_at:string}>();
 return{protocolVersion:1,accepted:result.meta.changes>0,reportSequence:current?.report_sequence??0,updatedAt:current?.updated_at??null};
}
const dayStart=(now:Date)=>now.toISOString().slice(0,10)+'T00:00:00.000Z';
export const webFanoutEligibilitySql=`EXISTS(SELECT 1 FROM devices WHERE kind='desktop' AND can_sync=1 AND revoked_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM devices d LEFT JOIN sync_catchup_status s ON s.device_id=d.device_id
 WHERE d.kind='desktop' AND d.can_sync=1 AND d.revoked_at IS NULL AND
 (s.state IS NULL OR s.state!='idle' OR s.updated_at<=?1 OR s.finished_at IS NULL OR s.finished_at>=?2))`;
export async function readCatchupStatus(db:D1Database,now=new Date()){
 const rows=await db.prepare(`SELECT d.device_id,s.state,s.pending,s.finished_at,s.updated_at FROM devices d
 LEFT JOIN sync_catchup_status s ON s.device_id=d.device_id WHERE d.kind='desktop' AND d.can_sync=1 AND d.revoked_at IS NULL ORDER BY d.device_id`).all<{device_id:string;state:string|null;pending:number|null;finished_at:string|null;updated_at:string|null}>();
 const cutoff=now.valueOf()-catchupStatusCapability.staleAfterSeconds*1000;
 const devices=rows.results.map(row=>({deviceId:row.device_id,state:!row.updated_at||Date.parse(row.updated_at)<=cutoff?'unknown':row.state??'unknown',pending:row.pending,finishedAt:row.finished_at,updatedAt:row.updated_at}));
 const state=devices.length&&devices.every(d=>d.state==='idle')?'idle':devices.some(d=>d.state==='catching_up')?'catching_up':'unknown';
 const finished=devices.filter(d=>d.finishedAt).map(d=>Date.parse(d.finishedAt!));
 const notBefore=state==='idle'&&finished.length===devices.length?new Date(Date.UTC(new Date(Math.max(...finished)).getUTCFullYear(),new Date(Math.max(...finished)).getUTCMonth(),new Date(Math.max(...finished)).getUTCDate()+1)).toISOString():null;
 const eligible=state==='idle'&&notBefore!==null&&Date.parse(notBefore)<=now.valueOf();
 const used=(await db.prepare('SELECT credits FROM web_fanout_budget WHERE day=?1').bind(now.toISOString().slice(0,10)).first<number>('credits'))??0;
 return{protocolVersion:1,serverReadAt:now.toISOString(),staleAfterSeconds:catchupStatusCapability.staleAfterSeconds,state,devices,webFanout:{eligible,notBefore,dailyCredits:webFanoutDailyCredits,catchupDailyCredits:catchupWebFanoutDailyCredits,remainingCredits:Math.max(0,(eligible?webFanoutDailyCredits:catchupWebFanoutDailyCredits)-used)}};
}
export function webFanoutDeferred(){return new ContractError('web_fanout_deferred','This change cannot be sent yet. Your desktop may still be syncing or today’s allowance may be used up. You can still view the latest tasks.');}
export async function webFanoutReservation(db:D1Database,credits:number,now=new Date()){
 if(credits>webFanoutDailyCredits)throw new ContractError('web_fanout_too_large','This change is too large for the website. Use Openza Desktop.');
 const at=now.toISOString(),day=at.slice(0,10),cutoff=new Date(now.valueOf()-catchupStatusCapability.staleAfterSeconds*1000).toISOString();
 const eligible=await db.prepare(`SELECT CASE WHEN coalesce((SELECT credits FROM web_fanout_budget WHERE day=?3),0)+?4<=CASE WHEN ${webFanoutEligibilitySql} THEN ?5 ELSE ?6 END THEN 1 ELSE 0 END AS valid`).bind(cutoff,dayStart(now),day,credits,webFanoutDailyCredits,catchupWebFanoutDailyCredits).first<number>('valid');
 if(eligible!==1)throw webFanoutDeferred();
 // Repeat the catch-up predicate and shared allowance update in the same
 // transaction as the actual domain changes, receipt and device sequence.
 return db.prepare(`INSERT INTO web_fanout_budget(day,credits) SELECT ?3,CASE WHEN
 coalesce((SELECT credits FROM web_fanout_budget WHERE day=?3),0)+?4<=CASE WHEN ${webFanoutEligibilitySql} THEN ?5 ELSE ?6 END
 THEN ?4 ELSE ?5+1 END ON CONFLICT(day) DO UPDATE SET credits=web_fanout_budget.credits+excluded.credits`).bind(cutoff,dayStart(now),day,credits,webFanoutDailyCredits,catchupWebFanoutDailyCredits);
}
