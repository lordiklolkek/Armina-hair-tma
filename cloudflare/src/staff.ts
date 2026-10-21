import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv, Row } from './types';
import { ownerOnly, digest } from './auth';
import { audit, guard, nowSeconds } from './booking';

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
staff.get('/owner/barbers',ownerOnly,async c=>c.json((await c.env.DB.prepare(`SELECT b.*,(SELECT count(*) FROM bookings k WHERE k.barber_id=b.id AND k.status IN('confirmed','pending') AND k.ends_at>unixepoch()) future_count FROM barbers b ORDER BY b.archived,b.name`).all()).results));
staff.post('/owner/barbers',ownerOnly,async c=>{
 const d=z.object({name:text}).strict().parse(await c.req.json()),id=crypto.randomUUID();
 await c.env.DB.batch([c.env.DB.prepare('INSERT INTO barbers(id,name) VALUES(?,?)').bind(id,d.name),audit(c.env.DB,c.get('identity').id,'barber.create',id)]);
 return c.json({id},201);
});
staff.patch('/owner/barbers/:id',ownerOnly,async c=>{
 const d=z.object({version:z.number().int().positive(),name:text.optional(),description:z.string().max(1000).optional(),photo_url:url.optional(),
 active:z.boolean().optional(),archived:z.boolean().optional(),online_enabled:z.boolean().optional(),revoke_access:z.boolean().optional(),future_action:z.literal('keep').optional()}).strict().parse(await c.req.json());
 const id=c.req.param('id'),old=await c.env.DB.prepare('SELECT * FROM barbers WHERE id=?').bind(id).first<Row>();
 if(!old)throw new HTTPException(404,{message:'NOT_FOUND'});
 const future=await c.env.DB.prepare("SELECT count(*) n FROM bookings WHERE barber_id=? AND status IN('confirmed','pending') AND ends_at>unixepoch()").bind(id).first<{n:number}>();
 if((d.active===false||d.archived===true)&&future!.n&&d.future_action!=='keep')return c.json({error:'FUTURE_BOOKINGS',count:future!.n},409);
 const active=Number(d.active??Boolean(old.active)),archived=Number(d.archived??Boolean(old.archived)),online=Number(d.online_enabled??Boolean(old.online_enabled));
 if(active&&online&&!archived){
  const ready=await c.env.DB.prepare('SELECT (EXISTS(SELECT 1 FROM working_hours WHERE barber_id=?) AND EXISTS(SELECT 1 FROM barber_services WHERE barber_id=?)) ok').bind(id,id).first<{ok:number}>();
  if(!ready?.ok)throw new HTTPException(409,{message:'BARBER_NOT_CONFIGURED'});
 }
 await c.env.DB.batch([
  ...guard(c.env.DB,'EXISTS(SELECT 1 FROM barbers WHERE id=? AND version=?)',id,d.version),
  c.env.DB.prepare('UPDATE barbers SET name=?,description=?,photo_url=?,active=?,archived=?,online_enabled=?,telegram_id=?,version=version+1 WHERE id=?')
   .bind(d.name??old.name,d.description??old.description,d.photo_url===undefined?old.photo_url:d.photo_url,active,archived,archived||!active?0:online,!active||archived||d.revoke_access?null:old.telegram_id,id),
  c.env.DB.prepare('DELETE FROM invitations WHERE barber_id=?').bind(id),audit(c.env.DB,c.get('identity').id,'barber.update',id)
 ]);
 return c.json({ok:true,future_count:future!.n});
});
staff.post('/owner/barbers/:id/invitation',ownerOnly,async c=>{
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
 const [hours,absences]=await c.env.DB.batch([c.env.DB.prepare('SELECT weekday,start_minute,end_minute FROM working_hours WHERE barber_id=? ORDER BY weekday,start_minute').bind(id),
 c.env.DB.prepare('SELECT * FROM absences WHERE barber_id=? ORDER BY starts_at').bind(id)]);
 return c.json({hours:hours.results,absences:absences.results});
});
staff.put('/staff/:id/schedule',async c=>{
 const id=c.req.param('id');scope(c,id);
 const d=z.object({hours:z.array(z.object({weekday:z.number().int().min(0).max(6),start_minute:z.number().int().min(0).max(1435).multipleOf(5),end_minute:z.number().int().min(5).max(1440).multipleOf(5)}).strict().refine(v=>v.end_minute>v.start_minute)).max(28)}).strict().parse(await c.req.json());
 const sorted=[...d.hours].sort((a,b)=>a.weekday-b.weekday||a.start_minute-b.start_minute);
 if(sorted.some((v,i)=>i&&v.weekday===sorted[i-1].weekday&&v.start_minute<sorted[i-1].end_minute))throw new HTTPException(422,{message:'INVALID_SCHEDULE'});
 await c.env.DB.batch([
  c.env.DB.prepare('DELETE FROM working_hours WHERE barber_id=?').bind(id),
  ...d.hours.map(h=>c.env.DB.prepare('INSERT INTO working_hours(id,barber_id,weekday,start_minute,end_minute) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),id,h.weekday,h.start_minute,h.end_minute)),
  ...guard(c.env.DB,`NOT EXISTS(SELECT 1 FROM bookings b WHERE b.barber_id=? AND b.status IN('confirmed','pending') AND b.ends_at>unixepoch() AND NOT EXISTS(
   SELECT 1 FROM working_hours w WHERE w.barber_id=b.barber_id AND w.weekday=(CAST(strftime('%w',b.starts_at,'unixepoch','+4 hours') AS INTEGER)+6)%7
   AND b.starts_at>=unixepoch(date(b.starts_at,'unixepoch','+4 hours')||'T00:00:00+04:00')+w.start_minute*60
   AND b.ends_at<=unixepoch(date(b.starts_at,'unixepoch','+4 hours')||'T00:00:00+04:00')+w.end_minute*60))`,id),
  audit(c.env.DB,c.get('identity').id,'schedule.update',id)
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
