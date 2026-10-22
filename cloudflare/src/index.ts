import { updateArmenianMenu } from './menu';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { z, ZodError } from 'zod';
import type { AppEnv, Env, Row } from './types';
import { authenticate, ownerOnly, equal } from './auth';
import { createBooking, bookingInput, getSlots, dayInput, allowedDate, audit, guard, nowSeconds } from './booking';
import { staff } from './staff';
import { calendar } from './calendar';
import { diagnostics } from './diagnostics';
import { contact, contactEnabled } from './contact';
import { checkBotConnection } from './bot-status';
import { forwardLegacyCallback } from './legacy';
import { runApprovedCutover } from './cutover';
import { exports } from './exports';
import { deferDelivery } from './delivery';
import { processWebhook, runNotifications } from './telegram';

export const app=new Hono<AppEnv>();
app.use('*',async(c,next)=>{await next();c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','no-referrer');c.header('Cache-Control','no-store');});
app.use('/api/*',bodyLimit({maxSize:16384,onError:c=>c.json({error:'BODY_TOO_LARGE'},413)}));
app.use('/telegram/*',bodyLimit({maxSize:32768,onError:c=>c.json({error:'BODY_TOO_LARGE'},413)}));
app.onError((err,c)=>{
 if(err instanceof HTTPException)return c.json({error:err.message},err.status);
 if(err instanceof ZodError||err instanceof SyntaxError)return c.json({error:'INVALID_INPUT'},422);
 if(String(err).includes('INVALID_SCHEDULE'))return c.json({error:'INVALID_SCHEDULE'},422);
 const known=['BOOKING_CONFLICT','BOOKING_LIMIT','CLIENT_BLOCKED','ABSENCE_CONFLICT','OUTSIDE_SCHEDULE','BARBER_UNAVAILABLE','SCHEDULE_CONFLICT'];
 const code=known.find(code=>String(err).includes(code));
 if(code)return c.json({error:code},409);
 if(String(err).includes('CHECK constraint failed: ok=1'))return c.json({error:'STATE_CONFLICT'},409);
 if(String(err).includes('FOREIGN KEY constraint'))return c.json({error:'NOT_FOUND'},404);
 // Do not print request bodies, tokens, database exceptions or contact details.
 console.error(JSON.stringify({event:'api_error',kind:err.name}));
 return c.json({error:'SERVICE_UNAVAILABLE'},503);
});
app.get('/health',async c=>{try{await c.env.DB.prepare('SELECT 1').first();return c.json({ok:true,mode:'demo'});}catch{return c.json({ok:false},503);}});
app.get('/api/config',async c=>c.json({...await c.env.DB.prepare('SELECT * FROM settings WHERE id=1').first(),mode:'demo',timezone:'Asia/Yerevan',currency:'AMD',real_bookings:false,
 contact_verification:contactEnabled(c.env),
 telegram_bot_username:/^[A-Za-z0-9_]{5,32}$/.test(c.env.BOT_USERNAME||'')&&c.env.WEBHOOK_SECRET&&c.env.TELEGRAM_LINKS_ENABLED==='true'?c.env.BOT_USERNAME:'',
 telegram_app_url:/^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}(?:\/[A-Za-z0-9_]{1,64})?$/.test(c.env.MINI_APP_URL||'')?c.env.MINI_APP_URL:''}));
app.get('/api/catalog',async c=>{
 const [services,barbers,links,away]=await c.env.DB.batch([
  c.env.DB.prepare('SELECT * FROM services WHERE active=1 ORDER BY sort_order,id'),
  c.env.DB.prepare('SELECT id,name,description,photo_url FROM barbers WHERE active=1 AND archived=0 AND online_enabled=1 ORDER BY name'),
  c.env.DB.prepare('SELECT * FROM barber_services'),
  c.env.DB.prepare("SELECT barber_id,starts_at,ends_at,CASE WHEN kind='vacation' THEN 'vacation' ELSE 'unavailable' END kind FROM absences WHERE ends_at>unixepoch()")
 ]);
 return c.json({services:services.results,barbers:barbers.results,links:links.results,absences:away.results});
});
app.post('/telegram/webhook',async c=>{
 // Reject before reading JSON. Webhook registration is deliberately not automatic.
 if(!c.env.WEBHOOK_SECRET||!equal(c.req.header('X-Telegram-Bot-Api-Secret-Token')||'',c.env.WEBHOOK_SECRET))throw new HTTPException(403,{message:'FORBIDDEN'});
 const update=await c.req.json();
 if(update.callback_query)await forwardLegacyCallback(c.env,update);
 else {
  await processWebhook(c.env,c.req.header('X-Telegram-Bot-Api-Secret-Token')!,update);
  deferDelivery(c,`update:${update.update_id}`);
 }
 return c.json({ok:true});
});
app.use('/api/*',authenticate);
app.get('/api/me',c=>c.json({...c.get('identity'),mode:'demo'}));
app.put('/api/me/language',async c=>{const d=z.object({language:z.enum(['hy','ru'])}).strict().parse(await c.req.json());await c.env.DB.prepare('UPDATE users SET language=? WHERE telegram_id=?').bind(d.language,c.get('identity').id).run();return c.json({ok:true});});
app.get('/api/slots',async c=>{
 const day=dayInput.parse(c.req.query('date'));const service=z.string().min(1).max(80).parse(c.req.query('service_id'));
 const who=c.get('identity'),barber=c.req.query('barber_id')||null,manual=c.req.query('manual')==='1';
 if(manual&&(!barber||!who.owner&&who.barberId!==barber))throw new HTTPException(403,{message:'FORBIDDEN'});
 let reschedule:Row|null=null;
 if(c.req.query('booking_id')){
  reschedule=await c.env.DB.prepare('SELECT b.*,c.telegram_id FROM bookings b JOIN clients c ON c.id=b.client_id WHERE b.id=?').bind(c.req.query('booking_id')).first<Row>();
  if(!reschedule||!who.owner&&who.barberId!==reschedule.barber_id&&reschedule.telegram_id!==who.id)throw new HTTPException(403,{message:'FORBIDDEN'});
  if(!barber||reschedule.barber_id!==barber&&!who.owner||reschedule.service_id!==service)throw new HTTPException(422,{message:'INVALID_INPUT'});
 }
 return c.json({slots:await getSlots(c.env,service,day,barber,reschedule,manual||Boolean(reschedule&&who.owner))});
});
app.post('/api/bookings',async c=>{
 const visit=await createBooking(c.env,c.get('identity'),bookingInput.parse(await c.req.json()),c.req.header('Idempotency-Key')||'');
 deferDelivery(c,'booking:'+visit.id);return c.json(visit,201);
});
app.post('/api/manual-bookings',async c=>{
 const visit=await createBooking(c.env,c.get('identity'),bookingInput.parse(await c.req.json()),c.req.header('Idempotency-Key')||'',true);
 deferDelivery(c,'booking:'+visit.id);return c.json(visit,201);
});
app.get('/api/bookings',async c=>{
 const who=c.get('identity'),mode=c.req.query('scope')||'mine';
 let condition='c.telegram_id=?',param:any=who.id;
 if(mode==='staff'){if(!who.barberId)throw new HTTPException(403,{message:'FORBIDDEN'});condition='b.barber_id=?';param=who.barberId;}
 if(mode==='all'){if(!who.owner)throw new HTTPException(403,{message:'FORBIDDEN'});condition='1=?';param=1;}
 const records=await c.env.DB.prepare(`SELECT b.*,c.name client_name,c.phone,bm.name barber_name FROM bookings b JOIN clients c ON c.id=b.client_id JOIN barbers bm ON bm.id=b.barber_id WHERE ${condition} ORDER BY b.starts_at DESC LIMIT 200`).bind(param).all();
 return c.json(records.results);
});
app.patch('/api/bookings/:id',async c=>{
 const d=z.object({version:z.number().int().positive(),starts_at:z.number().int().positive().multipleOf(300).optional(),barber_id:z.string().min(1).max(80).optional(),extra_minutes:z.number().int().min(0).max(120).multipleOf(5).optional(),
 status:z.enum(['confirmed','cancelled','completed','no_show']).optional(),final_price:z.number().int().min(0).max(20000000).optional()}).strict().parse(await c.req.json());
 const id=c.req.param('id'),who=c.get('identity');
 const old=await c.env.DB.prepare('SELECT b.*,c.telegram_id FROM bookings b JOIN clients c ON c.id=b.client_id WHERE b.id=?').bind(id).first<Row>();
 if(!old)throw new HTTPException(404,{message:'NOT_FOUND'});
 const manager=who.owner||who.barberId===old.barber_id;
 if(d.barber_id!==undefined&&!who.owner)throw new HTTPException(403,{message:'FORBIDDEN'});
 if(!manager&&old.telegram_id!==who.id)throw new HTTPException(403,{message:'FORBIDDEN'});
 if(old.version!==d.version)throw new HTTPException(409,{message:'STATE_CONFLICT'});
 if(!manager&&(d.extra_minutes!==undefined||d.final_price!==undefined||d.status&&d.status!=='cancelled'))throw new HTTPException(403,{message:'FORBIDDEN'});
 if(!['pending','confirmed'].includes(old.status)||!manager&&old.starts_at<=nowSeconds())throw new HTTPException(409,{message:'STATE_CONFLICT'});
 if((d.status==='completed'||d.status==='no_show')&&old.starts_at>nowSeconds())throw new HTTPException(409,{message:'VISIT_NOT_STARTED'});
 if(d.starts_at!==undefined||d.barber_id!==undefined)await allowedDate(c.env,d.starts_at??old.starts_at);
 const start=d.starts_at??old.starts_at,end=start+(old.ends_at-old.starts_at)+(d.extra_minutes||0)*60;
 await c.env.DB.batch([
  ...guard(c.env.DB,'EXISTS(SELECT 1 FROM bookings WHERE id=? AND version=? AND status IN(\'pending\',\'confirmed\'))',id,d.version),
  c.env.DB.prepare('UPDATE bookings SET barber_id=?,starts_at=?,ends_at=?,status=?,final_price=?,version=version+1 WHERE id=?').bind(d.barber_id??old.barber_id,start,end,d.status??old.status,d.final_price??old.final_price,id),audit(c.env.DB,who.id,'booking.update',id)
 ]);
 deferDelivery(c,'booking:'+id);return c.json({ok:true,version:d.version+1});
});
app.route('/api',staff);
app.route('/api',calendar);
app.route('/api',diagnostics);
app.route('/api',contact);
app.route('/api',exports);
app.get('/api/owner/diagnostics',ownerOnly,async c=>c.json((await c.env.DB.prepare('SELECT state,count(*) count FROM outbox GROUP BY state').all()).results));
app.get('/api/owner/telegram-status',ownerOnly,async c=>{
 const cached=await c.env.DB.prepare("SELECT payload,checked_at FROM integration_status WHERE id='telegram'").first<Row>();
 if(cached&&cached.checked_at>nowSeconds()-60)return c.json(JSON.parse(cached.payload));
 return c.json(await checkBotConnection(c.env)||{ok:false,checked_at:null});
});
app.put('/api/owner/settings',ownerOnly,async c=>{
 const d=z.object({name:z.string().trim().min(1).max(100),address:z.string().trim().min(1).max(250),logo_url:z.url().refine(v=>new URL(v).protocol==='https:').nullable(),advance_days:z.number().int().min(1).max(90),notice_minutes:z.number().int().min(0).max(1440)}).strict().parse(await c.req.json());
 await c.env.DB.batch([c.env.DB.prepare('UPDATE settings SET name=?,address=?,logo_url=?,advance_days=?,notice_minutes=? WHERE id=1').bind(d.name,d.address,d.logo_url,d.advance_days,d.notice_minutes),audit(c.env.DB,c.get('identity').id,'settings.update','1')]);return c.json({ok:true});
});
app.all('/api/*',c=>c.json({error:'NOT_FOUND'},404));
app.all('*',c=>c.env.ASSETS?c.env.ASSETS.fetch(c.req.raw):c.text('37 Barbershop · Demo',200));
export default {fetch:app.fetch,scheduled:(_event:ScheduledController,env:Env,ctx:ExecutionContext)=>{
 ctx.waitUntil(runNotifications(env));
 ctx.waitUntil((async()=>{await runApprovedCutover(env);await updateArmenianMenu(env);await checkBotConnection(env);})());
}};
