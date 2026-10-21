import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { app } from '../src/index';
import { runNotifications, processWebhook } from '../src/telegram';
import type { Env, Row } from '../src/types';

let mf:Miniflare,env:Env,db:D1Database;
const token='123456:TEST_ONLY_TOKEN',secret='TEST_ONLY_WEBHOOK_SECRET_123456789012345';
function signed(id:number,age=0){
 const fields={auth_date:String(Math.floor(Date.now()/1000)-age),query_id:`test-${id}`,user:JSON.stringify({id,first_name:'TEST'})};
 const check=Object.entries(fields).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
 const key=createHmac('sha256','WebAppData').update(token).digest();
 return new URLSearchParams({...fields,hash:createHmac('sha256',key).update(check).digest('hex')}).toString();
}
async function request(path:string,id:number|null=101,method='GET',data?:unknown,key?:string,overrides:Partial<Env>={}){
 return app.request(`https://demo.test${path}`,{method,headers:{...(id?{'X-Telegram-Init-Data':signed(id)}:{}),...(data?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},body:data?JSON.stringify(data):undefined},{...env,...overrides});
}
const book=(id:number,start=slot(),key=`booking_${id}`,barber='demo-a',service='cut')=>request('/api/bookings',id,'POST',{service_id:service,barber_id:barber,starts_at:start},key);
function slot(hour=10){const date=new Date(Date.now()+3*86400000);if(date.getUTCDay()===0)date.setUTCDate(date.getUTCDate()+1);return Date.parse(date.toISOString().slice(0,10)+`T${String(hour).padStart(2,'0')}:00:00+04:00`)/1000;}
async function sqlFile(file:string){for(const sql of (await readFile(file,'utf8')).split('-- statement-breakpoint'))if(sql.trim())await db.prepare(sql.trim()).run();}
before(async()=>{
 mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("test")}}',compatibilityDate:'2026-07-01',d1Databases:{DB:'test-db'}});
 db=await mf.getD1Database('DB') as unknown as D1Database;
 env={DB:db,BOT_TOKEN:token,WEBHOOK_SECRET:secret,APP_MODE:'demo',OWNER_IDS:'1',DEMO_USER_IDS:'1,101,102,103,104,201,202',BOT_USERNAME:'TestOnly_Bot'};
 for(const name of (await readdir('migrations')).filter(x=>x.endsWith('.sql')).sort())await sqlFile(`migrations/${name}`);
});
beforeEach(async()=>{
 for(const table of ['outbox','notes','invitations','bookings','clients','working_hours','absences','barber_services','barbers','services','users','telegram_updates','rate_limits','audit_log'])await db.prepare(`DELETE FROM ${table}`).run();
 await sqlFile('seeds/demo.sql');
});
after(async()=>{await mf?.dispose();});

test('health, public demo catalog and private signed API',async()=>{
 assert.equal((await request('/health',null)).status,200);
 assert.equal((await (await request('/api/config',null)).json() as Row).real_bookings,false);
 const catalog=await (await request('/api/catalog',null)).json() as Row;
 assert.equal(catalog.services.length,8);assert.equal(catalog.barbers.length,3);
 assert.equal((await request('/api/me',null)).status,401);
 assert.equal((await request('/api/me',999)).status,403);
 assert.equal((await request('/api/me',101,'GET',undefined,undefined,{APP_MODE:'production'})).status,503);
 assert.equal((await request('/api/owner/barbers',101)).status,403);
});
test('invalid, expired, future and duplicate initData cannot authenticate',async()=>{
 for(const raw of [signed(101)+'&user=forged',signed(101,4000),signed(101,-90),signed(101).replace('query_id=test','query_id=forged')]){
  const r=await app.request('https://demo.test/api/me',{headers:{'X-Telegram-Init-Data':raw}},env);assert.equal(r.status,401);
 }
});
test('concurrent online requests reserve one full interval',async()=>{
 const results=await Promise.all([book(101),book(102)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
 const overlap=await book(103,slot()+15*60);assert.equal(overlap.status,409);
 const adjacent=await book(104,slot()+30*60);assert.equal(adjacent.status,201);
 assert.equal((await db.prepare('SELECT count(*) n FROM bookings').first<Row>())!.n,2);
});
test('manual and online requests share the same atomic conflict guard',async()=>{
 const [online,manual]=await Promise.all([book(101),request('/api/manual-bookings',1,'POST',{service_id:'cut',barber_id:'demo-a',starts_at:slot()},'manual_001')]);
 assert.deepEqual([online.status,manual.status].sort(),[201,409]);
 assert.equal((await request('/api/manual-bookings',101,'POST',{service_id:'cut',barber_id:'demo-b',starts_at:slot()},'manual_002')).status,403);
});
test('idempotency handles concurrent double click and rejects changed payload',async()=>{
 const [a,b]=await Promise.all([book(101),book(101)]);assert.equal(a.status,201);assert.equal(b.status,201);
 assert.equal((await a.json() as Row).id,(await b.json() as Row).id);
 assert.equal((await book(101,slot(11))).status,409);
 assert.equal((await db.prepare('SELECT count(*) n FROM bookings').first<Row>())!.n,1);
 assert.equal((await db.prepare('SELECT count(*) n FROM outbox').first<Row>())!.n,1);
});
test('new client limit is atomic even across two barbers',async()=>{
 const results=await Promise.all([book(101,slot(),'first_001','demo-a'),book(101,slot(11),'first_002','demo-b')]);
 assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
});
test('price and duration are immutable snapshots when catalog changes',async()=>{
 const r=await book(101,slot(),'range_001','demo-a','shave');assert.equal(r.status,201);const booking=await r.json() as Row;
 assert.equal(booking.price_min,1000);assert.equal(booking.price_max,2000);
 await db.prepare("UPDATE services SET price_min=4000,price_max=5000,duration=60 WHERE id='shave'").run();
 await db.prepare("UPDATE barber_services SET duration=45 WHERE barber_id='demo-a' AND service_id='shave'").run();
 const old=await db.prepare('SELECT * FROM bookings WHERE id=?').bind(booking.id).first<Row>();
 assert.equal(old!.price_min,1000);assert.equal(old!.ends_at-old!.starts_at,1800);
 const second=await book(102,slot(11),'range_002','demo-a','shave');assert.equal(second.status,201);
 const newer=await second.json() as Row;assert.equal(newer.ends_at-newer.starts_at,2700);assert.equal(newer.price_max,5000);
});
test('schedule replacement and absence conflicts roll back without losing visits',async()=>{
 assert.equal((await book(101)).status,201);
 const original=await db.prepare("SELECT count(*) n FROM working_hours WHERE barber_id='demo-a'").first<Row>();
 const schedule=await request('/api/staff/demo-a/schedule',1,'PUT',{hours:[]});assert.equal(schedule.status,409);
 assert.equal((await db.prepare("SELECT count(*) n FROM working_hours WHERE barber_id='demo-a'").first<Row>())!.n,original!.n);
 const absence=await request('/api/staff/demo-a/absences',1,'POST',{starts_at:slot(),ends_at:slot()+86400,kind:'vacation'});assert.equal(absence.status,409);
 assert.equal((await db.prepare('SELECT count(*) n FROM absences').first<Row>())!.n,0);
});
test('vacations and split working intervals remove unavailable slots',async()=>{
 const r=await request('/api/staff/demo-a/absences',1,'POST',{starts_at:slot(),ends_at:slot()+3600,kind:'vacation'});assert.equal(r.status,201);
 const date=new Date((slot()+14400)*1000).toISOString().slice(0,10);
 const slots=(await (await request(`/api/slots?service_id=cut&barber_id=demo-a&date=${date}`)).json() as Row).slots as Row[];
 assert(!slots.some(s=>s.starts_at===slot()));assert(!slots.some(s=>s.starts_at===slot(14)));assert(slots.some(s=>s.starts_at===slot(15)));
 assert.equal((await book(101)).status,409);
});
test('client may cancel own visit, cannot read staff data or edit another visit',async()=>{
 const created=await (await book(101)).json() as Row;
 assert.equal((await request(`/api/bookings/${created.id}`,102,'PATCH',{version:1,status:'cancelled'})).status,403);
 assert.equal((await request('/api/bookings?scope=all',101)).status,403);
 assert.equal((await request('/api/staff/demo-a/clients',101)).status,403);
 assert.equal((await request(`/api/bookings/${created.id}`,101,'PATCH',{version:1,status:'cancelled'})).status,200);
 assert.equal((await book(102)).status,201);
});
test('reschedule conflict preserves original interval and version',async()=>{
 const first=await (await book(101)).json() as Row;assert.equal((await book(102,slot(11))).status,201);
 assert.equal((await request(`/api/bookings/${first.id}`,101,'PATCH',{version:1,starts_at:slot(11)})).status,409);
 const old=await db.prepare('SELECT * FROM bookings WHERE id=?').bind(first.id).first<Row>();assert.equal(old!.starts_at,slot());assert.equal(old!.version,1);
 assert.equal((await request(`/api/bookings/${first.id}`,101,'PATCH',{version:1,starts_at:slot(12)})).status,200);
 assert.equal((await request(`/api/bookings/${first.id}`,101,'PATCH',{version:1,status:'cancelled'})).status,409);
});
test('archive requires acknowledgement, preserves history and revokes staff access',async()=>{
 await request('/api/me',201);await db.prepare("UPDATE barbers SET telegram_id=201 WHERE id='demo-a'").run();
 assert.equal((await request('/api/staff/demo-a/schedule',201)).status,200);
 assert.equal((await request('/api/staff/demo-b/schedule',201)).status,403);
 const created=await (await book(101)).json() as Row;
 assert.equal((await request('/api/owner/barbers/demo-a',1,'PATCH',{version:1,archived:true})).status,409);
 assert.equal((await request('/api/owner/barbers/demo-a',1,'PATCH',{version:1,archived:true,future_action:'keep'})).status,200);
 assert.equal((await request('/api/staff/demo-a/schedule',201)).status,403);
 assert.equal((await book(102,slot(11))).status,409);
 assert(await db.prepare('SELECT id FROM bookings WHERE id=?').bind(created.id).first());
});
test('one-time invitations bind only an allowed private Telegram account',async()=>{
 const invite=await (await request('/api/owner/barbers/demo-a/invitation',1,'POST',{})).json() as Row;
 const code=invite.url.split('start=')[1];
 const update={update_id:500,message:{from:{id:201},chat:{id:201,type:'private'},text:`/start ${code}`}};
 await processWebhook(env,secret,update);await processWebhook(env,secret,update);
 assert.equal((await request('/api/me',201).then(r=>r.json()) as Row).barberId,'demo-a');
 await assert.rejects(()=>processWebhook(env,secret,{...update,update_id:501,message:{...update.message,from:{id:202},chat:{id:202,type:'private'}}}));
 assert.equal((await db.prepare("SELECT telegram_id FROM barbers WHERE id='demo-a'").first<Row>())!.telegram_id,201);
});
test('demo webhook rejects secrets and does not collect genuine contacts',async()=>{
 assert.equal((await request('/telegram/webhook',null,'POST',{update_id:1})).status,403);
 await processWebhook(env,secret,{update_id:77,message:{from:{id:101},chat:{id:101,type:'private'},contact:{user_id:101,phone_number:'+37400000000'}}});
 assert.equal((await db.prepare('SELECT phone FROM users WHERE telegram_id=101').first<Row>())!.phone,null);
});
test('outbox retries failures, concurrent Cron does not claim the same delivery',async()=>{
 await book(101);let sends=0;
 const sender=async()=>{sends++;return {ok:true,code:200,retry_after:0};};
 await Promise.all([runNotifications(env,sender),runNotifications(env,sender)]);assert.equal(sends,1);
 await runNotifications(env,sender);assert.equal(sends,1);
 await db.prepare("UPDATE outbox SET state='pending',next_attempt_at=0").run();
 await runNotifications(env,async()=>({ok:false,code:429,retry_after:100}));
 const row=await db.prepare('SELECT * FROM outbox').first<Row>();assert.equal(row!.state,'pending');assert(row!.next_attempt_at>Math.floor(Date.now()/1000));
});
test('reschedule slot preview keeps booked duration and excludes its own interval',async()=>{
 const booking=await (await book(101)).json() as Row;
 await db.prepare("UPDATE services SET duration=5 WHERE id='cut'").run();
 const date=new Date((slot()+14400)*1000).toISOString().slice(0,10);
 const response=await request(`/api/slots?service_id=cut&barber_id=demo-a&date=${date}&booking_id=${booking.id}`,101);
 assert.equal(response.status,200);const slots=(await response.json() as Row).slots as Row[];
 assert(slots.some(s=>s.starts_at===slot()));assert(!slots.some(s=>timeText(s.starts_at)==='13:55'));
 assert.equal((await request(`/api/slots?service_id=cut&barber_id=demo-a&date=${date}&booking_id=${booking.id}`,102)).status,403);
 function timeText(v:number){return new Date((v+14400)*1000).toISOString().slice(11,16);}
});
test('concurrent schedule edit and online booking cannot leave an orphaned interval',async()=>{
 const [booking,schedule]=await Promise.all([book(101),request('/api/staff/demo-a/schedule',1,'PUT',{hours:[]})]);
 const rows=await db.prepare('SELECT * FROM bookings').all<Row>();
 if(rows.results.length){
  assert.equal(booking.status,201);assert.equal(schedule.status,409);
  assert((await db.prepare("SELECT count(*) n FROM working_hours WHERE barber_id='demo-a'").first<Row>())!.n>0);
 }else{assert.equal(booking.status,409);assert.equal(schedule.status,200);}
});
test('demo rejects real contact fields and exhausted notification leases terminate',async()=>{
 const result=await request('/api/bookings',101,'POST',{service_id:'cut',barber_id:'demo-a',starts_at:slot(),phone:'+37400000000'},'contact_001');assert.equal(result.status,422);
 await db.prepare("INSERT INTO outbox(id,chat_id,text,state,attempts,lease_until) VALUES('exhausted',101,'test','sending',5,0)").run();
 await runNotifications(env,async()=>{throw Error('must not send');});
 assert.equal((await db.prepare("SELECT state FROM outbox WHERE id='exhausted'").first<Row>())!.state,'failed');
});
