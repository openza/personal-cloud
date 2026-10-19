import {ContractError} from './protocol.ts';

export type DailyQuota = {protocolVersion:1;resource:'d1_rows_read'|'d1_rows_written';resetAt:string};
export const dailyQuotaMessage='Personal Cloud reached a daily Cloudflare limit. Sync can resume after the next UTC reset.';
export function nextUtcReset(now:Date):string {
  return new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1)).toISOString();
}
export class DailyQuotaError extends ContractError {
  readonly quota:DailyQuota;
  constructor(resource:DailyQuota['resource'],now=new Date()){
    super('daily_quota_exceeded',dailyQuotaMessage);
    this.quota={protocolVersion:1,resource,resetAt:nextUtcReset(now)};
  }
}
// Only documented D1 daily row errors qualify. Never return source error/SQL text.
export function dailyQuotaError(error:unknown,now=new Date()):DailyQuotaError|null {
  const seen=new Set<unknown>();
  for(let depth=0;depth<4&&error&&typeof error==='object'&&!seen.has(error);depth++){
    if(error instanceof DailyQuotaError)return error;
    seen.add(error);
    const value=error as {message?:unknown;cause?:unknown};
    if(typeof value.message==='string'&&value.message.length<=4096){
      const match=/^(?:D1_ERROR:\s*)?Your account has exceeded D1['’]s free tier daily row (read|write) limit\.(?:\s|$)/.exec(value.message);
      if(match)return new DailyQuotaError(match[1]==='read'?'d1_rows_read':'d1_rows_written',now);
    }
    error=value.cause;
  }
  return null;
}
export function throwDailyQuota(error:unknown):void {
  const quota=dailyQuotaError(error);if(quota)throw quota;
}
