import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Env, Identity, Row } from './types';
import { digest } from './auth';

export const nowSeconds=()=>Math.floor(Date.now()/1000);
export const bookingInput=z.object({service_id:z.string().min(1).max(80),barber_id:z.string().min(1).max(80).nullable().default(null),
 starts_at:z.number().int().positive().refine(v=>v%300===0)}).strict();
export const dayInput=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v+'T00:00:00+04:00'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v);
export function dayStart(day:string){return Date.parse(day+'T00:00:00+04:00')/1000;}
export function localDay(time:number){return new Date((time+14400)*1000).toISOString().slice(0,10);}
export const audit=(db:D1Database,actor:number,action:string,id:string)=>db.prepare('INSERT INTO audit_log(id,actor,action,entity_id) VALUES(?,?,?,?)').bind(crypto.randomUUID(),actor,action,id);
export function guard(db:D1Database,sql:string,...values:any[]){
 const id=crypto.randomUUID();return [db.prepare(`INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN (${sql}) THEN 1 ELSE 0 END`).bind(id,...values),db.prepare('DELETE FROM mutation_guards WHERE id=?').bind(id)];
}
export async function allowedDate(env:Env,start:number){
 const settings=await env.DB.prepare('SELECT advance_days,notice_minutes FROM settings WHERE id=1').first<Row>();
 const today=dayStart(localDay(nowSeconds()));
 if(start<nowSeconds()+Number(settings!.notice_minutes)*60||start>=today+(Number(settings!.advance_days)+1)*86400)throw new HTTPException(422,{message:'DATE_UNAVAILABLE'});
}
export async function getSlots(env:Env,serviceId:string,day:string,barberId:string|null,reschedule:Row|null=null,manual=false){
 const start=dayStart(day);const setting=await env.DB.prepare('SELECT * FROM settings WHERE id=1').first<Row>();
 if(start<dayStart(localDay(nowSeconds()))||start>dayStart(localDay(nowSeconds()))+Number(setting!.advance_days)*86400)throw new HTTPException(422,{message:'DATE_UNAVAILABLE'});
 const barbers=(await env.DB.prepare(`SELECT b.id,COALESCE(?,bs.duration,s.duration) duration FROM barbers b
 JOIN barber_services bs ON bs.barber_id=b.id JOIN services s ON s.id=bs.service_id
 WHERE s.id=? AND (s.active=1 OR ?=1) AND b.active=1 AND b.archived=0 AND (?=1 OR b.online_enabled=1) AND (? IS NULL OR b.id=?) ORDER BY b.id`).bind(reschedule?(reschedule.ends_at-reschedule.starts_at)/60:null,serviceId,Number(Boolean(reschedule)),Number(manual),barberId,barberId).all<Row>()).results;
 const weekday=(new Date((start+14400)*1000).getUTCDay()+6)%7;
 const [hours,busy,away]=await env.DB.batch([
  env.DB.prepare(`SELECT w.* FROM effective_working_hours w WHERE w.day=? OR (w.day IS NULL AND w.weekday=?
   AND NOT EXISTS(SELECT 1 FROM schedule_overrides o WHERE o.barber_id=w.barber_id AND o.day=?))`).bind(day,weekday,day),
  env.DB.prepare("SELECT barber_id,client_id,starts_at,ends_at FROM bookings WHERE status IN('confirmed','pending') AND starts_at<? AND ends_at>? AND (? IS NULL OR id!=?)").bind(start+86400,start,reschedule?.id||null,reschedule?.id||null),
  env.DB.prepare('SELECT barber_id,starts_at,ends_at FROM absences WHERE starts_at<? AND ends_at>?').bind(start+86400,start)
 ]);
 const slots: {starts_at:number;barber_ids:string[]}[]=[];
 for(let min=0;min<1440;min+=5){
  const starts=start+min*60;if(starts<nowSeconds()+Number(setting!.notice_minutes)*60)continue;
  const eligible=barbers.filter(b=>{
   const ends=starts+Number(b.duration)*60;
   return hours.results.some((h:any)=>h.barber_id===b.id&&min>=h.start_minute&&min+Number(b.duration)<=h.end_minute)
    &&![...busy.results,...away.results].some((x:any)=>(x.barber_id===b.id||reschedule&&x.client_id===reschedule.client_id)&&x.starts_at<ends&&x.ends_at>starts);
  }).map(b=>b.id);
  if(eligible.length)slots.push({starts_at:starts,barber_ids:eligible});
 }
 return slots;
}
export async function createBooking(env:Env,identity:Identity,input:z.infer<typeof bookingInput>,key:string,manual=false){
 if(!/^[A-Za-z0-9_-]{8,100}$/.test(key))throw new HTTPException(422,{message:'IDEMPOTENCY_REQUIRED'});
 const hash=await digest(JSON.stringify([input.service_id,input.barber_id,input.starts_at,manual]));
 const existing=await env.DB.prepare('SELECT * FROM bookings WHERE created_by=? AND idempotency_key=?').bind(identity.id,key).first<Row>();
 if(existing){if(existing.request_hash!==hash)throw new HTTPException(409,{message:'IDEMPOTENCY_MISMATCH'});return existing;}
 await allowedDate(env,input.starts_at);
 if(manual&&!identity.owner&&!identity.barberId)throw new HTTPException(403,{message:'FORBIDDEN'});
 if(manual&&(!input.barber_id||!identity.owner&&input.barber_id!==identity.barberId))throw new HTTPException(403,{message:'FORBIDDEN'});
 if(!manual&&env.CONTACT_VERIFICATION_ENABLED==='true'&&!await env.DB.prepare('SELECT telegram_id FROM users WHERE telegram_id=? AND phone IS NOT NULL AND phone_verified_at IS NOT NULL').bind(identity.id).first())throw new HTTPException(409,{message:'PHONE_REQUIRED'});
 // Closed demo stores invented names/numbers only. Real contact intake stays disabled.
 const clientId=manual?crypto.randomUUID():`tg:${identity.id}`;
 const candidates=(await env.DB.prepare(`SELECT b.id,COALESCE(bs.duration,s.duration) duration FROM barbers b
 JOIN barber_services bs ON bs.barber_id=b.id JOIN services s ON s.id=bs.service_id
 WHERE s.id=? AND b.active=1 AND b.archived=0 AND s.active=1 AND (?=1 OR b.online_enabled=1) AND (? IS NULL OR b.id=?) ORDER BY b.id`).bind(input.service_id,Number(manual),input.barber_id,input.barber_id).all<Row>()).results;
 if(!candidates.length)throw new HTTPException(409,{message:'BARBER_UNAVAILABLE'});
 for(const candidate of candidates){
  const id=crypto.randomUUID(),ends=input.starts_at+Number(candidate.duration)*60;
  try{
   await env.DB.batch([
    ...(!manual&&env.CONTACT_VERIFICATION_ENABLED==='true'?guard(env.DB,'EXISTS(SELECT 1 FROM users WHERE telegram_id=? AND phone IS NOT NULL AND phone_verified_at IS NOT NULL)',identity.id):[]),
    env.DB.prepare('INSERT OR IGNORE INTO clients(id,telegram_id,name,phone) VALUES(?,?,?,NULL)').bind(clientId,manual?null:identity.id,'Դեմո հաճախորդ / Демо-клиент'),
    ...(!manual&&env.CONTACT_VERIFICATION_ENABLED==='true'?[env.DB.prepare('UPDATE clients SET phone=(SELECT phone FROM users WHERE telegram_id=?) WHERE id=?').bind(identity.id,clientId)]:[]),
    env.DB.prepare(`INSERT INTO bookings(id,client_id,barber_id,service_id,title_hy,title_ru,price_min,price_max,starts_at,ends_at,status,source,created_by,idempotency_key,request_hash)
     SELECT ?,?,?,id,title_hy,title_ru,price_min,price_max,?,?,'confirmed',?,?,?,? FROM services WHERE id=? AND active=1`)
     .bind(id,clientId,candidate.id,input.starts_at,ends,manual?'manual':'online',identity.id,key,hash,input.service_id),
    ...guard(env.DB,'EXISTS(SELECT 1 FROM bookings WHERE id=?)',id),audit(env.DB,identity.id,'booking.create',id)
   ]);
   return (await env.DB.prepare('SELECT * FROM bookings WHERE id=?').bind(id).first<Row>())!;
  }catch(error){
   const duplicate=await env.DB.prepare('SELECT * FROM bookings WHERE created_by=? AND idempotency_key=?').bind(identity.id,key).first<Row>();
   if(duplicate){if(duplicate.request_hash!==hash)throw new HTTPException(409,{message:'IDEMPOTENCY_MISMATCH'});return duplicate;}
   const message=String(error);if(/BOOKING_LIMIT|CLIENT_BLOCKED/.test(message))throw error;
   if(!/BOOKING_CONFLICT|OUTSIDE_SCHEDULE|ABSENCE_CONFLICT|BARBER_UNAVAILABLE/.test(message)||input.barber_id)throw error;
  }
 }
 throw new HTTPException(409,{message:'BOOKING_CONFLICT'});
}
