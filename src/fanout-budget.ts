import {ContractError} from './protocol.ts';

export const fanoutBudgetCapability={protocolVersion:1,requestHeader:'x-openza-fanout-bound'} as const;
export function parseFanoutBound(value:string|null):number|undefined {
 if(value===null)return undefined;
 if(!/^(0|[1-9][0-9]{0,15})$/.test(value)||!Number.isSafeInteger(Number(value)))
  throw new ContractError('invalid_request','Invalid fan-out upper bound.');
 return Number(value);
}
export function fanoutBoundError():ContractError {
 return new ContractError('fanout_bound_exceeded','The tasks or projects affected by this change have changed. Refresh and try again.');
}
// This count is checked again inside the mutation transaction. The optional
// header is request metadata; it never changes canonical mutation identity.
export async function fanoutGuard(db:D1Database,mutationId:string,entityId:string,selection:string,bound:number){
 const count=`SELECT count(*) AS n FROM (${selection})`;
 const actual=await db.prepare(count).bind(entityId).first<number>('n');
 if(actual===null||actual>bound)throw fanoutBoundError();
 // Existing workspace guards use 0/1. NULL gives this guard a distinct existing
 // NOT NULL constraint failure, without adding a schema object or migration.
 return db.prepare(`INSERT INTO workspace_guards(id,valid) SELECT ?3,CASE WHEN (${count})<=?2 THEN 1 ELSE NULL END`).bind(entityId,bound,mutationId+':fanout');
}
