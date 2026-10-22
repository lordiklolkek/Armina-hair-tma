import { HTTPException } from 'hono/http-exception';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './types';

const encoder = new TextEncoder();
export const ids = (raw = '') => raw.split(',').map(x=>x.trim()).filter(x=>/^[1-9]\d*$/.test(x));
export async function hmac(key: Uint8Array, text: string) {
 const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, {name:'HMAC',hash:'SHA-256'},false,['sign']);
 return new Uint8Array(await crypto.subtle.sign('HMAC',cryptoKey,encoder.encode(text)));
}
export const hex = (data: Uint8Array) => Array.from(data,x=>x.toString(16).padStart(2,'0')).join('');
export async function digest(value: string) {return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))));}
export function equal(a: string,b: string) {let diff=a.length^b.length; for(let i=0;i<Math.max(a.length,b.length);i++) diff|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return diff===0;}
export async function verifyInitData(raw: string, token: string, now = Math.floor(Date.now()/1000)): Promise<number> {
 try {
  if(!raw||raw.length>8192||!token) throw Error();
  const params=new URLSearchParams(raw), entries=[...params.entries()];
  if(new Set(entries.map(x=>x[0])).size!==entries.length) throw Error();
  const hash=params.get('hash')||''; if(!/^[0-9a-f]{64}$/i.test(hash)) throw Error();
  params.delete('hash');
  const check=[...params.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=await hmac(encoder.encode('WebAppData'),token);
  if(!equal(hex(await hmac(secret,check)),hash.toLowerCase())) throw Error();
  const age=now-Number(params.get('auth_date'));
  if(!Number.isFinite(age)||age < -30||age>3600||!/^\d+$/.test(params.get('auth_date')||'')) throw Error();
  const user=JSON.parse(params.get('user')||'null');
  if(!user||!Number.isSafeInteger(user.id)||user.id<=0) throw Error();
  return user.id;
 } catch {throw new HTTPException(401,{message:'AUTH_REQUIRED'});}
}
export const authenticate: MiddlewareHandler<AppEnv> = async(c,next)=>{
 if(c.env.APP_MODE!=='demo') throw new HTTPException(503,{message:'LIVE_NOT_ENABLED'});
 const id=await verifyInitData(c.req.header('X-Telegram-Init-Data')||'',c.env.BOT_TOKEN||'');
 if(!ids(c.env.DEMO_USER_IDS).includes(String(id))) throw new HTTPException(403,{message:'DEMO_PRIVATE'});
 await c.env.DB.prepare('INSERT OR IGNORE INTO users(telegram_id) VALUES(?)').bind(id).run();
 const user=await c.env.DB.prepare('SELECT language FROM users WHERE telegram_id=?').bind(id).first<{language:'hy'|'ru'}>();
 const barber=await c.env.DB.prepare('SELECT id FROM barbers WHERE telegram_id=? AND active=1 AND archived=0').bind(id).first<{id:string}>();
 c.set('identity',{id,owner:[...ids(c.env.OWNER_IDS),...ids(c.env.ADMIN_IDS)].includes(String(id)),barberId:barber?.id||null,language:user?.language||'hy'});
 const window=Math.floor(Date.now()/60000);
 const count=await c.env.DB.prepare(`INSERT INTO rate_limits(key,window,count) VALUES(?,?,1)
 ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END,window=excluded.window RETURNING count`).bind(`user:${id}`,window).first<{count:number}>();
 if((count?.count||0)>120) throw new HTTPException(429,{message:'RATE_LIMIT'});
 await next();
};
export const ownerOnly: MiddlewareHandler<AppEnv> = async(c,next)=>{if(!c.get('identity').owner)throw new HTTPException(403,{message:'FORBIDDEN'});await next();};
