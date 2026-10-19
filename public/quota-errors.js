export const maximumQuotaBodyBytes=65536;
export const nextUtcReset=value=>new Date(Date.UTC(value.getUTCFullYear(),value.getUTCMonth(),value.getUTCDate()+1)).toISOString();
const canonical=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
export function responseTime(headers,now){const value=headers?.get?.('date');const parsed=value?Date.parse(value):NaN;return Number.isFinite(parsed)&&Math.abs(parsed-now)<=2*86400000?parsed:now;}
export function typedQuota(result,observedAt){
  const q=result?.protocolVersion===1&&result?.product==='tasks'&&result.error?.code==='daily_quota_exceeded'&&result.error?.retryable===true?result.error.quota:null;
  if(q?.protocolVersion!==1||!Object.keys(q).every(key=>['protocolVersion','resetAt','resource'].includes(key))||!['d1_rows_read','d1_rows_written'].includes(q.resource))return null;
  const fallback=nextUtcReset(new Date(observedAt));
  // Valid quota identity always brakes. A bad hint cannot turn it into a retry storm.
  return{protocolVersion:1,resource:q.resource,resetAt:canonical(q.resetAt)&&q.resetAt===fallback?q.resetAt:fallback};
}
// Representative edge structures only; no generic 429, digit or task-content match.
export function workers1027(status,headers,body){
  if(status<400||status>599||typeof body!=='string'||new TextEncoder().encode(body).length>maximumQuotaBodyBytes)return false;
  if(headers.get('server')?.trim().toLowerCase()!=='cloudflare'&&!headers.get('cf-ray')?.trim())return false;
  const type=headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if(type==='text/plain')return /^error code:\s*1027$/i.test(body.trim());
  if(type!=='text/html'||!/<title\b[^>]{0,256}>[^<]{0,512}(?:Cloudflare|Error\s+1027)[^<]{0,512}<\/title\s*>/i.test(body))return false;
  for(const match of body.matchAll(/<span\b([^>]{0,2048})>\s*1027\s*<\/span\s*>/gi)){
    // Tokenize complete attributes: data-class and class-looking text inside
    // another quoted attribute must never count as the actual class attribute.
    const attrs=match[1],attribute=/\s+([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gy;
    let at=0,classes=null,valid=true;
    while(at<attrs.length&&!/^\s*$/.test(attrs.slice(at))){
      attribute.lastIndex=at;const parsed=attribute.exec(attrs);if(!parsed){valid=false;break;}at=attribute.lastIndex;
      if(parsed[1].toLowerCase()==='class'){if(classes!==null){valid=false;break;}classes=parsed[2]??parsed[3]??parsed[4]??'';}
    }
    if(valid&&classes?.split(/\s+/).includes('cf-error-code'))return true;
  }
  return false;
}
export async function boundedErrorText(response){
  const reader=response.body?.getReader?.();if(!reader)return typeof response.text==='function'?String(await response.text()).slice(0,maximumQuotaBodyBytes+1):'';
  const chunks=[];let bytes=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maximumQuotaBodyBytes){await reader.cancel();return ''; }chunks.push(value);}}
  finally{reader.releaseLock();}
  const buffer=new Uint8Array(bytes);let at=0;for(const chunk of chunks){buffer.set(chunk,at);at+=chunk.length;}return new TextDecoder().decode(buffer);
}
