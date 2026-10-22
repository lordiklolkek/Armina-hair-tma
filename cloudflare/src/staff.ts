import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv, Row } from './types';
import { ownerOnly, digest } from './auth';
import { audit, guard, nowSeconds, dayInput, dayStart, localDay } from './booking';

export const staff=new Hono<AppEnv>();
function scope(c:any,id:string){const who=c.get('identity');if(!who.owner&&who.barberId!==id)throw new HTTPException(403,{message:'FORBIDDEN'});}
const text=z.string().trim().min(1).max(100), url=z.url().refine(v=>new URL(v).protocol==='https:').nullable();
const serviceSchema=z.object({title_hy:text,title_ru:text,description_hy:z.string().max(500).default(''),description_ru:z.string().max(500).default(''),
 price_min:z.number().int().min(0).max(20000000),price_max:z.number().int().min(0).max(20000000),
 duration:z.number().int().min(5).max(480).multipleOf(5),active:z.boolean().default(true),sort_order:z.number().int().default(0)}).strict().refine(x=>x.price_max>=x.price_min);
staff.get('/owner/services',ownerOnly,async c=>c.json((await c.env.DB.prepare('SELECT * FROM services ORDER BY sort_order,id').all()).results));
staff.post('/owner/services',ownerOnly,async c=>{
 const data=serviceSchema.parse(await c.req.json()),id=crypto.randomUUID();
 await c.env.DB.batch([c.env.DB.prepare('INSERT INTO services(id,title_hy,title_ru,description_hy,description_ru,price_min,price_max,duration,active,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?)')
 .bind(id,data.title_hy,data.title_ru,data.description_hy,data.description_ru,data.price_min,data.price_max,data.duration,Number(data.active),data.sort_order),audit(c.env.DB,c.get('identity').id,'service.create',id)]);
 return c.json({id},201);
});
staff.put('/owner/services/:id',ownerOnly,async c=>{
 const d=serviceSchema.parse(await c.req.json()),id=c.req.param('id');
 if(!await c.env.DB.prepare('SELECT id FROM services WHERE id=?').bind(id).first())throw new HTTPException(404,{message:'NOT_FOUND'});
 await c.env.DB.batch([c.env.DB.prepare('UPDATE services SET title_hy=?,title_ru=?,description_hy=?,description_ru=?,price_min=?,price_max=?,duration=?,active=?,sort_order=? WHERE id=?')
 .bind(d.title_hy,d.title_ru,d.description_hy,d.description_ru,d.price_min,d.price_max,d.duration,Number(d.active),d.sort_order,id),audit(c.env.DB,c.get('identity').id,'service.update',id)]);
 return c.json({ok:true});
});
staff.get('/owner/barbers',ownerOnly,async c=>c.json((await c.env.DB.prepare(`SELECT b.*,(SELECT count(*) FROM bookings k WHERE k.barber_id=b.id AND k.status IN('confirmed','pending') AND k.ends_at>unixepoch()) future_count,(SELECT count(*) FROM barber_services bs JOIN services s ON s.id=bs.service_id WHERE bs.barber_id=b.id AND s.active=1) service_count,(SELECT count(*) FROM working_hours h WHERE h.barber_id=b.id) working_hours_count FROM barbers b ORDER BY b.archived,b.name`).all()).results));
staff.post('/owner/barbers',ownerOnly,async c=>{
 const d=z.object({name:text}).strict().parse(await c.req.json()),id=crypto.randomUUID();
 await c.env.DB.batch([c.env.DB.prepare('INSERT INTO barbers(id,name) VALUES(?,?)').bind(id,d.name),audit(c.env.DB,c.get('identity').id,'barber.create',id)]);
 return c.json({id},201);
});
staff.patch('/owner/barbers/:id',ownerOnly,async c=>{
 const d=z.object({version:z.number().int().positive(),name:text.optional(),description:z.string().max(1000).optional(),photo_url:url.optional(),
 active:z.boolean().optional(),archived:z.boolean().optional(),online_enabled:z.boolean().optional(),revoke_access:z.boolean().optional(),future_action:z.enum(['keep','cancel']).optional(),
 expected_future_count:z.number().int().nonnegative().optional(),expected_bookings_revision:z.number().int().nonnegative().optional()}).strict().parse(await c.req.json());
 const id=c.req.param('id'),old=await c.env.DB.prepare('SELECT * FROM barbers WHERE id=?').bind(id).first<Row>();
 if(!old)throw new HTTPException(404,{message:'NOT_FOUND'});
 const future=await c.env.DB.prepare("SELECT count(*) n FROM bookings WHERE barber_id=? AND status IN('confirmed','pending') AND ends_at>unixepoch()").bind(id).first<{n:number}>();
 const disabling=d.active===false||d.archived===true;
 if(d.future_action&&!disabling)throw new HTTPException(422,{message:'INVALID_INPUT'});
 if(disabling&&future!.n&&!d.future_action)return c.json({error:'FUTURE_BOOKINGS',count:future!.n},409);
 if(d.future_action==='cancel'&&(d.expected_future_count===undefined||d.expected_bookings_revision===undefined))throw new HTTPException(422,{message:'INVALID_INPUT'});
 const active=Number(d.active??Boolean(old.active)),archived=Number(d.archived??Boolean(old.archived)),online=Number(d.online_enabled??Boolean(old.online_enabled));
 if(active&&online&&!archived){
  const ready=await c.env.DB.prepare('SELECT (EXISTS(SELECT 1 FROM working_hours WHERE barber_id=?) AND EXISTS(SELECT 1 FROM barber_services WHERE barber_id=?)) ok').bind(id,id).first<{ok:number}>();
  if(!ready?.ok)throw new HTTPException(409,{message:'BARBER_NOT_CONFIGURED'});
 }
 await c.env.DB.batch([
  ...guard(c.env.DB,'EXISTS(SELECT 1 FROM barbers WHERE id=? AND version=?)',id,d.version),
  ...(disabling?guard(c.env.DB,"(SELECT count(*) FROM bookings WHERE barber_id=? AND status IN('confirmed','pending') AND ends_at>unixepoch())=?",id,d.expected_future_count??future!.n):[]),
  ...(d.expected_bookings_revision!==undefined?guard(c.env.DB,'EXISTS(SELECT 1 FROM barbers WHERE id=? AND bookings_revision=?)',id,d.expected_bookings_revision):[]),
  ...(d.future_action==='cancel'?[c.env.DB.prepare("UPDATE bookings SET status='cancelled',version=version+1 WHERE barber_id=? AND status IN('confirmed','pending') AND ends_at>unixepoch()").bind(id),audit(c.env.DB,c.get('identity').id,'barber.future.cancel',id)]:[]),
  c.env.DB.prepare('UPDATE barbers SET name=?,description=?,photo_url=?,active=?,archived=?,online_enabled=?,telegram_id=?,version=version+1 WHERE id=?')
   .bind(d.name??old.name,d.description??old.description,d.photo_url===undefined?old.photo_url:d.photo_url,active,archived,archived||!active?0:online,!active||archived||d.revoke_access?null:old.telegram_id,id),
  c.env.DB.prepare('DELETE FROM invitations WHERE barber_id=?').bind(id),audit(c.env.DB,c.get('identity').id,'barber.update',id)
 ]);
 return c.json({ok:true,future_count:future!.n});
});
staff.get('/owner/barbers/:id/future-bookings',ownerOnly,async c=>{
 const id=c.req.param('id'),barber=await c.env.DB.prepare("SELECT b.*,(SELECT count(*) FROM bookings k WHERE k.barber_id=b.id AND k.status IN('confirmed','pending') AND k.ends_at>unixepoch()) future_count FROM barbers b WHERE id=?").bind(id).first<Row>();
 if(!barber)throw new HTTPException(404,{message:'NOT_FOUND'});
 const cursor=c.req.query('cursor');let after=0,last='';
 if(cursor){const valid=z.string().regex(/^\d{1,12}\.[A-Za-z0-9_-]{1,80}$/).parse(cursor);const parts=valid.split('.');after=Number(parts[0]);last=parts[1];}
 const rows=(await c.env.DB.prepare(`SELECT b.*,c.name client_name,c.phone,bm.name barber_name FROM bookings b JOIN clients c ON c.id=b.client_id JOIN barbers bm ON bm.id=b.barber_id
  WHERE b.barber_id=? AND b.status IN('confirmed','pending') AND b.ends_at>unixepoch() AND (b.starts_at>? OR (b.starts_at=? AND b.id>?)) ORDER BY b.starts_at,b.id LIMIT 101`).bind(id,after,after,last).all<Row>()).results;
 const items=rows.slice(0,100),tail=items.at(-1);return c.json({barber,items,next_cursor:rows.length>100?`${tail!.starts_at}.${tail!.id}`:null});
});
staff.post('/owner/barbers/:id/invitation',ownerOnly,async c=>{
 if(!c.env.WEBHOOK_SECRET||!/^[A-Za-z0-9_]{5,32}$/.test(c.env.BOT_USERNAME||''))throw new HTTPException(409,{message:'TELEGRAM_NOT_CONFIGURED'});
 if(c.env.APP_URL){
  const status=await c.env.DB.prepare("SELECT payload,checked_at FROM integration_status WHERE id='telegram'").first<Row>();
  if(!status||status.checked_at<nowSeconds()-600||!JSON.parse(status.payload).webhook_matches)throw new HTTPException(409,{message:'TELEGRAM_NOT_CONFIGURED'});
 }
 const id=c.req.param('id'),barber=await c.env.DB.prepare('SELECT * FROM barbers WHERE id=? AND active=1 AND archived=0').bind(id).first<Row>();
 if(!barber)throw new HTTPException(404,{message:'NOT_FOUND'});
 if(barber.telegram_id)throw new HTTPException(409,{message:'REVOKE_ACCESS_FIRST'});
 const token=crypto.randomUUID().replaceAll('-',''),hash=await digest(token);
 await c.env.DB.batch([c.env.DB.prepare('DELETE FROM invitations WHERE barber_id=?').bind(id),
  c.env.DB.prepare('INSERT INTO invitations(token_hash,barber_id,expires_at,created_by) VALUES(?,?,?,?)').bind(hash,id,nowSeconds()+900,c.get('identity').id),audit(c.env.DB,c.get('identity').id,'barber.invite',id)]);
 return c.json({url:`https://t.me/${c.env.BOT_USERNAME}?start=join_${token}`,expires_in:900});
});
staff.get('/staff/:id/schedule',async c=>{
 const id=c.req.param('id');scope(c,id);
 const [hours,absences,overrides]=await c.env.DB.batch([c.env.DB.prepare('SELECT weekday,start_minute,end_minute FROM working_hours WHERE barber_id=? ORDER BY weekday,start_minute').bind(id),
 c.env.DB.prepare('SELECT * FROM absences WHERE barber_id=? ORDER BY starts_at').bind(id),
 c.env.DB.prepare('SELECT day,hours_json,version FROM schedule_overrides WHERE barber_id=? AND day>=? ORDER BY day LIMIT 366').bind(id,localDay(nowSeconds()))]);
 return c.json({hours:hours.results,absences:absences.results,overrides:overrides.results.map((o:any)=>({day:o.day,hours:JSON.parse(o.hours_json),version:o.version}))});
});
staff.put('/staff/:id/schedule',async c=>{
 const id=c.req.param('id');scope(c,id);
 const d=z.object({hours:z.array(z.object({weekday:z.number().int().min(0).max(6),start_minute:z.number().int().min(0).max(1435).multipleOf(5),end_minute:z.number().int().min(5).max(1440).multipleOf(5)}).strict().refine(v=>v.end_minute>v.start_minute)).max(28)}).strict().parse(await c.req.json());
 const sorted=[...d.hours].sort((a,b)=>a.weekday-b.weekday||a.start_minute-b.start_minute);
 if(sorted.some((v,i)=>i&&v.weekday===sorted[i-1].weekday&&v.start_minute<sorted[i-1].end_minute))throw new HTTPException(422,{message:'INVALID_SCHEDULE'});
 await c.env.DB.batch([
  c.env.DB.prepare('DELETE FROM working_hours WHERE barber_id=?').bind(id),
  ...d.hours.map(h=>c.env.DB.prepare('INSERT INTO working_hours(id,barber_id,weekday,start_minute,end_minute) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),id,h.weekday,h.start_minute,h.end_minute)),
  ...guard(c.env.DB,'NOT EXISTS(SELECT 1 FROM booking_schedule_violations WHERE barber_id=?)',id),
  audit(c.env.DB,c.get('identity').id,'schedule.update',id)
 ]);
 return c.json({ok:true});
});
const dateHours=z.array(z.object({start_minute:z.number().int().min(0).max(1435).multipleOf(5),end_minute:z.number().int().min(5).max(1440).multipleOf(5)}).strict().refine(v=>v.end_minute>v.start_minute)).max(8)
 .refine(hours=>{const sorted=[...hours].sort((a,b)=>a.start_minute-b.start_minute);return !sorted.some((h,i)=>i>0&&h.start_minute<sorted[i-1].end_minute);});
staff.put('/staff/:id/schedule/dates/:day',async c=>{
 const id=c.req.param('id');scope(c,id);const day=dayInput.parse(c.req.param('day'));
 const d=z.object({hours:dateHours,version:z.number().int().positive().nullable().default(null)}).strict().parse(await c.req.json());
 const today=dayStart(localDay(nowSeconds()));if(dayStart(day)<today||dayStart(day)>today+365*86400)throw new HTTPException(422,{message:'DATE_UNAVAILABLE'});
 await c.env.DB.batch([
  ...guard(c.env.DB,d.version===null?'NOT EXISTS(SELECT 1 FROM schedule_overrides WHERE barber_id=? AND day=?)':'EXISTS(SELECT 1 FROM schedule_overrides WHERE barber_id=? AND day=? AND version=?)',id,day,...(d.version===null?[]:[d.version])),
  c.env.DB.prepare('INSERT INTO schedule_overrides(barber_id,day,hours_json) VALUES(?,?,?) ON CONFLICT(barber_id,day) DO UPDATE SET hours_json=excluded.hours_json,version=schedule_overrides.version+1').bind(id,day,JSON.stringify(d.hours)),
  audit(c.env.DB,c.get('identity').id,'schedule.date.update',id+':'+day)
 ]);
 return c.json({ok:true,version:(d.version||0)+1});
});
staff.delete('/staff/:id/schedule/dates/:day',async c=>{
 const id=c.req.param('id');scope(c,id);const day=dayInput.parse(c.req.param('day'));
 const d=z.object({version:z.number().int().positive()}).strict().parse(await c.req.json());
 await c.env.DB.batch([
  ...guard(c.env.DB,'EXISTS(SELECT 1 FROM schedule_overrides WHERE barber_id=? AND day=? AND version=?)',id,day,d.version),
  c.env.DB.prepare('DELETE FROM schedule_overrides WHERE barber_id=? AND day=?').bind(id,day),audit(c.env.DB,c.get('identity').id,'schedule.date.remove',id+':'+day)
 ]);
 return c.json({ok:true});
});
staff.post('/staff/:id/absences',async c=>{
 const barber=c.req.param('id');scope(c,barber);
 const d=z.object({starts_at:z.number().int().positive(),ends_at:z.number().int().positive(),kind:z.enum(['vacation','unavailable','break'])}).strict().refine(v=>v.ends_at>v.starts_at).parse(await c.req.json());
 const id=crypto.randomUUID();
 await c.env.DB.batch([c.env.DB.prepare('INSERT INTO absences(id,barber_id,starts_at,ends_at,kind) VALUES(?,?,?,?,?)').bind(id,barber,d.starts_at,d.ends_at,d.kind),audit(c.env.DB,c.get('identity').id,'absence.create',id)]);
 return c.json({id},201);
});
staff.delete('/staff/:id/absences/:absence',async c=>{
 scope(c,c.req.param('id'));
 await c.env.DB.batch([c.env.DB.prepare('DELETE FROM absences WHERE id=? AND barber_id=?').bind(c.req.param('absence'),c.req.param('id')),audit(c.env.DB,c.get('identity').id,'absence.delete',c.req.param('absence'))]);
 return c.json({ok:true});
});
staff.get('/staff/:id/services',async c=>{
 scope(c,c.req.param('id'));
 return c.json((await c.env.DB.prepare('SELECT s.*,bs.duration individual_duration FROM services s JOIN barber_services bs ON bs.service_id=s.id WHERE bs.barber_id=?').bind(c.req.param('id')).all()).results);
});
staff.put('/staff/:id/services/:service',async c=>{
 const id=c.req.param('id');scope(c,id);
 const d=z.object({duration:z.number().int().min(5).max(480).multipleOf(5).nullable(),enabled:z.boolean().default(true)}).strict().parse(await c.req.json());
 const exists=await c.env.DB.prepare('SELECT * FROM barber_services WHERE barber_id=? AND service_id=?').bind(id,c.req.param('service')).first();
 if(!c.get('identity').owner&&(!exists||!d.enabled))throw new HTTPException(403,{message:'FORBIDDEN'});
 await c.env.DB.batch([d.enabled?c.env.DB.prepare('INSERT INTO barber_services(barber_id,service_id,duration) VALUES(?,?,?) ON CONFLICT(barber_id,service_id) DO UPDATE SET duration=excluded.duration').bind(id,c.req.param('service'),d.duration):c.env.DB.prepare('DELETE FROM barber_services WHERE barber_id=? AND service_id=?').bind(id,c.req.param('service')),audit(c.env.DB,c.get('identity').id,'duration.update',id)]);
 return c.json({ok:true});
});
staff.get('/staff/:id/clients',async c=>{
 scope(c,c.req.param('id'));
 return c.json((await c.env.DB.prepare(`SELECT c.id,c.name,c.phone,n.text note FROM clients c
 LEFT JOIN notes n ON n.client_id=c.id AND n.barber_id=? WHERE EXISTS(SELECT 1 FROM bookings b WHERE b.client_id=c.id AND b.barber_id=?) LIMIT 200`).bind(c.req.param('id'),c.req.param('id')).all()).results);
});
staff.put('/staff/:id/notes/:client',async c=>{
 const id=c.req.param('id');scope(c,id);const d=z.object({text:z.string().max(2000)}).strict().parse(await c.req.json());
 const related=await c.env.DB.prepare('SELECT id FROM bookings WHERE barber_id=? AND client_id=? LIMIT 1').bind(id,c.req.param('client')).first();
 if(!related)throw new HTTPException(404,{message:'NOT_FOUND'});
 await c.env.DB.batch([c.env.DB.prepare('INSERT INTO notes(barber_id,client_id,text) VALUES(?,?,?) ON CONFLICT(barber_id,client_id) DO UPDATE SET text=excluded.text').bind(id,c.req.param('client'),d.text),audit(c.env.DB,c.get('identity').id,'note.update',c.req.param('client'))]);
 return c.json({ok:true});
});
staff.get('/owner/clients',ownerOnly,async c=>{
 const cursor=z.string().max(100).regex(/^[A-Za-z0-9:_-]*$/).parse(c.req.query('cursor')||'');
 const rows=(await c.env.DB.prepare(`SELECT c.id,c.name,c.phone,CASE WHEN c.telegram_id IS NULL THEN 0 ELSE 1 END has_telegram,
  COALESCE(u.blocked,0) blocked,(SELECT count(*) FROM bookings b WHERE b.client_id=c.id AND b.status='completed') completed_count,
  (SELECT count(*) FROM bookings b WHERE b.client_id=c.id AND b.status='no_show') no_show_count
  FROM clients c LEFT JOIN users u ON u.telegram_id=c.telegram_id WHERE c.id>? ORDER BY c.id LIMIT 101`).bind(cursor).all<Row>()).results;
 const items=rows.slice(0,100);return c.json({items,next_cursor:rows.length>100?items.at(-1)!.id:null});
});
staff.patch('/owner/clients/:id/access',ownerOnly,async c=>{
 const id=z.string().min(1).max(100).parse(c.req.param('id'));
 const d=z.object({blocked:z.boolean(),expected_blocked:z.boolean()}).strict().parse(await c.req.json());
 const client=await c.env.DB.prepare('SELECT telegram_id FROM clients WHERE id=?').bind(id).first<Row>();
 if(!client)throw new HTTPException(404,{message:'NOT_FOUND'});
 if(!client.telegram_id)throw new HTTPException(409,{message:'MANUAL_CLIENT'});
 await c.env.DB.batch([
  ...guard(c.env.DB,'EXISTS(SELECT 1 FROM users WHERE telegram_id=? AND blocked=?)',client.telegram_id,Number(d.expected_blocked)),
  c.env.DB.prepare('UPDATE users SET blocked=? WHERE telegram_id=?').bind(Number(d.blocked),client.telegram_id),
  audit(c.env.DB,c.get('identity').id,d.blocked?'client.block':'client.unblock',id)
 ]);
 return c.json({ok:true});
});
