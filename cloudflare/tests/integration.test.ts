import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { app } from '../src/index';
import { runNotifications, processWebhook } from '../src/telegram';
import { checkBotConnection } from '../src/bot-status';
import { forwardLegacyCallback } from '../src/legacy';
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
 for(const table of ['outbox','notes','invitations','bookings','clients','schedule_overrides','working_hours','absences','barber_services','barbers','services','contact_challenges','integration_status','users','telegram_updates','rate_limits','audit_log'])await db.prepare(`DELETE FROM ${table}`).run();
 await sqlFile('seeds/demo.sql');
});
after(async()=>{await mf?.dispose();});

test('contact attestation requires a fresh signed challenge and own Telegram contact',async()=>{
 const enabled={...env,CONTACT_VERIFICATION_ENABLED:'true'};
 const options={CONTACT_VERIFICATION_ENABLED:'true'};
 assert.equal((await request('/api/me/contact-challenge',101,'POST',{})).status,503);
 assert.equal((await request('/api/me/contact-challenge',101,'POST',{phone:'+37400000000'},undefined,options)).status,422);
 assert.equal((await request('/api/me/contact-challenge',101,'POST',{},undefined,options)).status,200);
 const now=Math.floor(Date.now()/1000);
 const update=(id:number,phone='+37400000000',user=101,extra:Row={})=>({update_id:id,message:{date:now,from:{id:101},chat:{id:101,type:'private'},contact:{user_id:user,phone_number:phone},...extra}});
 await processWebhook(enabled,secret,update(800,'+37400000000',102));
 await processWebhook(enabled,secret,update(801,'+37400000000',101,{forward_origin:{type:'user'}}));
 await processWebhook(enabled,secret,update(802,'fake-number'));
 assert.equal((await db.prepare('SELECT phone FROM users WHERE telegram_id=101').first<Row>())!.phone,null);
 await processWebhook(enabled,secret,update(803));await processWebhook(enabled,secret,update(803));
 const user=await db.prepare('SELECT phone,phone_verified_at FROM users WHERE telegram_id=101').first<Row>();
 assert.equal(user!.phone,'+37400000000');assert(user!.phone_verified_at);
 await processWebhook(enabled,secret,update(804,'+37411111111'));
 assert.equal((await db.prepare('SELECT phone FROM users WHERE telegram_id=101').first<Row>())!.phone,'+37400000000');
 const publicState=await (await request('/api/me/contact',101,'GET',undefined,undefined,options)).json() as Row;
 assert.deepEqual(publicState,{enabled:true,verified:true});
 assert(!(await db.prepare('SELECT text FROM outbox').all<Row>()).results.some(x=>x.text.includes('+374')));
});
test('old, unsolicited, group and expired contacts never verify a phone',async()=>{
 const enabled={...env,CONTACT_VERIFICATION_ENABLED:'true'},options={CONTACT_VERIFICATION_ENABLED:'true'},now=Math.floor(Date.now()/1000);
 const message={date:now,from:{id:101},chat:{id:101,type:'private'},contact:{user_id:101,phone_number:'37400000000'}};
 await processWebhook(enabled,secret,{update_id:810,message});
 assert.equal((await db.prepare('SELECT phone FROM users WHERE telegram_id=101').first<Row>())!.phone,null);
 await request('/api/me/contact-challenge',101,'POST',{},undefined,options);
 await processWebhook(enabled,secret,{update_id:811,message:{...message,date:now-1000}});
 await processWebhook(enabled,secret,{update_id:812,message:{...message,chat:{id:101,type:'group'}}});
 await processWebhook(enabled,secret,{update_id:813,message:{...message,chat:{id:102,type:'private'}}});
 await db.prepare('UPDATE contact_challenges SET requested_at=?,expires_at=? WHERE telegram_id=101').bind(now-1000,now-1).run();
 await processWebhook(enabled,secret,{update_id:814,message});
 assert.equal((await db.prepare('SELECT phone FROM users WHERE telegram_id=101').first<Row>())!.phone,null);
 assert.equal((await db.prepare('SELECT count(*) n FROM audit_log WHERE action=?').bind('contact.verified').first<Row>())!.n,0);
});
test('enabled phone gate blocks online booking and preserves verified contact with idempotency',async()=>{
 const options={CONTACT_VERIFICATION_ENABLED:'true'},body={service_id:'cut',barber_id:'demo-a',starts_at:slot()};
 const denied=await request('/api/bookings',101,'POST',body,'verified_booking',options);assert.equal(denied.status,409);assert.equal((await denied.json() as Row).error,'PHONE_REQUIRED');
 assert.equal((await db.prepare('SELECT count(*) n FROM bookings').first<Row>())!.n,0);
 await request('/api/me/contact-challenge',101,'POST',{},undefined,options);
 await processWebhook({...env,...options},secret,{update_id:820,message:{date:Math.floor(Date.now()/1000),from:{id:101},chat:{id:101,type:'private'},contact:{user_id:101,phone_number:'37400000000'}}});
 const a=await request('/api/bookings',101,'POST',body,'verified_booking',options);assert.equal(a.status,201);
 const b=await request('/api/bookings',101,'POST',body,'verified_booking',options);assert.equal(b.status,201);assert.equal((await a.json() as Row).id,(await b.json() as Row).id);
 assert.equal((await db.prepare('SELECT phone FROM clients WHERE telegram_id=101').first<Row>())!.phone,'+37400000000');
 assert.equal((await request('/api/manual-bookings',1,'POST',{...body,starts_at:slot(11)},'manual_no_phone',options)).status,201);
});
test('authorized administrator can operate independently without a barber profile',async()=>{
 const options={OWNER_IDS:'',ADMIN_IDS:'102'};
 const identity=await (await request('/api/me',102,'GET',undefined,undefined,options)).json() as Row;
 assert.equal(identity.owner,true);assert.equal(identity.barberId,null);
 assert.equal((await request('/api/owner/barbers',102,'GET',undefined,undefined,options)).status,200);
 assert.equal((await request('/api/owner/barbers',101,'GET',undefined,undefined,options)).status,403);
 assert.equal((await request('/api/owner/barbers',102,'GET',undefined,undefined,{...options,ADMIN_IDS:''})).status,403);
});
test('barbers cannot read or alter another profile clients visits and private notes',async()=>{
 for(const id of [201,202])await request('/api/me',id);
 await db.prepare("UPDATE barbers SET telegram_id=201 WHERE id='demo-a'").run();await db.prepare("UPDATE barbers SET telegram_id=202 WHERE id='demo-b'").run();
 const a=await (await book(101)).json() as Row,b=await (await book(102,slot(),'separate_barber','demo-b')).json() as Row;
 assert.equal((await request(`/api/staff/demo-a/notes/${a.client_id}`,201,'PUT',{text:'A PRIVATE'})).status,200);
 assert.equal((await request(`/api/staff/demo-b/notes/${b.client_id}`,202,'PUT',{text:'B PRIVATE'})).status,200);
 for(const path of ['/api/staff/demo-b/clients','/api/staff/demo-b/schedule','/api/staff/demo-b/services'])assert.equal((await request(path,201)).status,403);
 assert.equal((await request(`/api/staff/demo-b/notes/${b.client_id}`,201,'PUT',{text:'FORGED'})).status,403);
 assert.equal((await request(`/api/staff/demo-a/notes/${b.client_id}`,201,'PUT',{text:'FORGED'})).status,404);
 assert.equal((await request('/api/bookings/'+b.id,201,'PATCH',{version:1,status:'cancelled'})).status,403);
 const own=await (await request('/api/staff/demo-a/clients',201)).json() as Row[];assert.equal(own.length,1);assert.equal(own[0].note,'A PRIVATE');assert(!JSON.stringify(own).includes('B PRIVATE'));
 const visits=await (await request('/api/bookings?scope=staff',201)).json() as Row[];assert(visits.every(x=>x.barber_id==='demo-a'));
 const admin=await (await request('/api/staff/demo-b/clients',1)).json() as Row[];assert.equal(admin[0].note,'B PRIVATE');
});
test('bot launch preserves personal barber selection and rejects unsafe persisted keyboards',async()=>{
 const configured={...env,APP_URL:'https://demo.test/'};
 await processWebhook(configured,secret,{update_id:830,message:{from:{id:101},chat:{id:101,type:'private'},text:'/start barber_demo-a'}});
 const calls:Row[]=[];await runNotifications(configured,async(_e,_m,p)=>{calls.push(p as Row);return {ok:true,code:200,retry_after:0};});
 assert.equal(calls.length,1);assert.equal(calls[0].reply_markup.inline_keyboard[0][0].web_app.url,'https://demo.test/?barber=demo-a');
 await db.prepare("INSERT INTO outbox(id,chat_id,text,reply_markup) VALUES('unsafe-button',101,'test',?)").bind(JSON.stringify({inline_keyboard:[[{text:'Open',web_app:{url:'https://evil.test/'}}]]})).run();
 await runNotifications(configured,async(_e,_m,p)=>{calls.push(p as Row);return {ok:true,code:200,retry_after:0};});assert.equal(calls.length,1);
 assert.equal((await db.prepare("SELECT last_error FROM outbox WHERE id='unsafe-button'").first<Row>())!.last_error,'INVALID_PAYLOAD');
});
test('expired and concurrently claimed invitations are acknowledged without rebinding or retries',async()=>{
 const invite=await (await request('/api/owner/barbers/demo-a/invitation',1,'POST',{})).json() as Row;
 const update=(id:number,actor:number)=>({update_id:id,message:{from:{id:actor},chat:{id:actor,type:'private'},text:'/start '+invite.url.split('start=')[1]}});
 await Promise.all([processWebhook(env,secret,update(840,201)),processWebhook(env,secret,update(841,202))]);
 assert.equal((await db.prepare("SELECT count(*) n FROM barbers WHERE telegram_id IN(201,202)").first<Row>())!.n,1);
 assert.equal((await db.prepare('SELECT count(*) n FROM telegram_updates').first<Row>())!.n,2);
 const other=await (await request('/api/owner/barbers/demo-b/invitation',1,'POST',{})).json() as Row;await db.prepare("UPDATE invitations SET expires_at=0 WHERE barber_id='demo-b'").run();
 await processWebhook(env,secret,{update_id:842,message:{from:{id:103},chat:{id:103,type:'private'},text:'/start '+other.url.split('start=')[1]}});
 assert.equal((await db.prepare("SELECT telegram_id FROM barbers WHERE id='demo-b'").first<Row>())!.telegram_id,null);
});

test('bot connection monitoring uses only read methods and exposes no credentials',async()=>{
 const methods:string[]=[];
 const status=await checkBotConnection({...env,APP_URL:'https://demo.test/'},async(_env,method)=>{methods.push(method);return {ok:true,result:method==='getMe'?{username:'TestOnly_Bot',id:123}:{url:'https://demo.test/telegram/webhook',pending_update_count:2,last_error_message:'PRIVATE ERROR MUST NOT BE EXPOSED'}};});
 assert.deepEqual(methods,['getMe','getWebhookInfo']);assert.equal(status!.webhook_matches,true);
 assert.equal((await request('/api/owner/telegram-status',101)).status,403);
 const exposed=await (await request('/api/owner/telegram-status',1)).json() as Row;assert.equal(exposed.pending_updates,2);assert(!JSON.stringify(exposed).includes('PRIVATE ERROR'));assert(!JSON.stringify(exposed).includes(token));
});
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
test('legacy callback forwarding is explicit bounded and never silently discards old actions',async()=>{
 const update={update_id:850,callback_query:{id:'test',from:{id:101},data:'confirm_1'}};
 const response=await app.request('https://demo.test/telegram/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(update)},env);
 assert.equal(response.status,503);assert.equal((await response.json() as Row).error,'LEGACY_CALLBACK_NOT_READY');
 let calls=0;
 const configured={...env,LEGACY_CALLBACK_FORWARDING_ENABLED:'true',LEGACY_WEBHOOK_SECRET:'TEST_LEGACY_SECRET_ONLY'};
 await forwardLegacyCallback(configured,update,async(url,init)=>{calls++;assert.equal(url,'https://armina-hair-tma-demo.onrender.com/telegram/webhook');assert.equal((init!.headers as Row)['X-Telegram-Bot-Api-Secret-Token'],'TEST_LEGACY_SECRET_ONLY');assert.deepEqual(JSON.parse(init!.body as string),update);return new Response('{"ok":true}');});
 assert.equal(calls,1);
 await assert.rejects(()=>forwardLegacyCallback(configured,update,async()=>new Response('',{status:503})),/LEGACY_CALLBACK_UNAVAILABLE/);
 assert.equal((await request('/telegram/webhook',null,'POST',update)).status,403);
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
test('owner delivery diagnostics omit chat identifiers and message bodies and classify retry safely',async()=>{
 await db.prepare("INSERT INTO outbox(id,chat_id,text,state,last_error) VALUES('notice-network',101,'private body','failed','TELEGRAM_503'),('notice-old',101,'private body','failed','SUPERSEDED'),('notice-sent',101,'private body','sent',NULL)").run();
 assert.equal((await request('/api/owner/notifications',101)).status,403);
 const data=await (await request('/api/owner/notifications',1)).json() as Row;
 assert.equal(data.items.length,2);assert.equal(data.items.find((r:Row)=>r.id==='notice-network').can_retry,true);assert.equal(data.items.find((r:Row)=>r.id==='notice-old').can_retry,false);
 assert(!JSON.stringify(data).includes('private body'));assert(data.items.every((r:Row)=>!('chat_id' in r)&&!('text' in r)));
 assert.equal((await request('/api/owner/notifications?state=forged',1)).status,422);
});
test('delivery diagnostics paginate every failed job without duplicates or unrelated states',async()=>{
 const rows=Array.from({length:101},(_,i)=>'diagnostic-'+String(i).padStart(3,'0'));
 await db.prepare("INSERT INTO outbox(id,chat_id,text,state,last_error) SELECT value,101,'test','failed','TELEGRAM_503' FROM json_each(?)").bind(JSON.stringify(rows)).run();
 await db.prepare("INSERT INTO outbox(id,chat_id,text,state) VALUES('other-state',101,'test','sent')").run();
 const first=await (await request('/api/owner/notifications',1)).json() as Row;assert.equal(first.items.length,100);assert(first.next_cursor);
 const second=await (await request('/api/owner/notifications?cursor='+encodeURIComponent(first.next_cursor),1)).json() as Row;assert.equal(second.items.length,1);assert.equal(second.next_cursor,null);
 assert.equal(new Set([...first.items,...second.items].map((r:Row)=>r.id)).size,101);assert([...first.items,...second.items].every((r:Row)=>r.state==='failed'));
});
test('notification self-test targets the signed owner only and repeated presses share a queue entry',async()=>{
 assert.equal((await request('/api/owner/notifications/self-test',101,'POST',{})).status,403);
 assert.equal((await request('/api/owner/notifications/self-test',1,'POST',{chat_id:101})).status,422);
 assert.equal((await request('/api/owner/notifications/self-test',1,'POST',{},undefined,{BOT_TOKEN:''})).status,401);
 await request('/api/me/language',1,'PUT',{language:'ru'});
 const ids=[];for(let i=0;i<3;i++){const r=await request('/api/owner/notifications/self-test',1,'POST',{});assert.equal(r.status,200);ids.push((await r.json() as Row).id);}
 assert(ids[0]===ids[1]||ids[1]===ids[2]);const expected=new Set(ids).size;
 assert.equal((await db.prepare('SELECT count(*) n FROM outbox').first<Row>())!.n,expected);
 const sent:Row[]=[];const sender=async(_env:Env,_method:string,payload:unknown)=>{sent.push(payload as Row);return {ok:true,code:200,retry_after:0};};
 await runNotifications(env,sender);assert.equal(sent.length,expected);assert(sent.every(s=>s.chat_id===1&&s.text.includes('Тест уведомлений')));await runNotifications(env,sender);assert.equal(sent.length,expected);
 assert.equal((await db.prepare('SELECT count(*) n FROM bookings').first<Row>())!.n,0);
});
test('owner retry is atomic and cannot resurrect superseded or revoked staff messages',async()=>{
 await db.prepare("INSERT INTO outbox(id,chat_id,text,state,attempts,last_error) VALUES('notice-network',101,'test','failed',5,'TELEGRAM_503'),('notice-old',101,'test','failed',1,'SUPERSEDED'),('notice-revoked',201,'test','failed',1,'ACCESS_REVOKED')").run();
 assert.equal((await request('/api/owner/notifications/notice-network/retry',101,'POST',{})).status,403);
 assert.equal((await request('/api/owner/notifications/notice-old/retry',1,'POST',{})).status,409);
 assert.equal((await request('/api/owner/notifications/notice-revoked/retry',1,'POST',{})).status,409);
 const results=await Promise.all([request('/api/owner/notifications/notice-network/retry',1,'POST',{}),request('/api/owner/notifications/notice-network/retry',1,'POST',{})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 const job=await db.prepare("SELECT state,attempts FROM outbox WHERE id='notice-network'").first<Row>();assert.equal(job!.state,'pending');assert.equal(job!.attempts,0);
 assert.equal((await db.prepare("SELECT count(*) n FROM audit_log WHERE action='notification.retry'").first<Row>())!.n,1);
});
test('localized notification snapshots survive catalog edits and use recipient language at delivery',async()=>{
 await request('/api/me',201);await db.prepare("UPDATE barbers SET telegram_id=201 WHERE id='demo-a'").run();
 const b=await (await book(101)).json() as Row;
 await request('/api/me/language',101,'PUT',{language:'ru'});
 await db.prepare("UPDATE services SET title_ru='Изменённая услуга',price_min=9000,price_max=9000 WHERE id='cut'").run();
 const sent:Row[]=[];await runNotifications(env,async(_env,method,payload)=>{assert.equal(method,'sendMessage');sent.push(payload as Row);return {ok:true,code:200,retry_after:0};});
 assert.equal(sent.length,2);const client=sent.find(s=>s.chat_id===101)!,barber=sent.find(s=>s.chat_id===201)!;
 assert(client.text.startsWith('Запись подтверждена\nСтрижка'));assert.match(client.text,/2\s000 ֏/);assert(!client.text.includes('Изменённая услуга'));
 assert(barber.text.startsWith('Նոր գրանցում'));assert(!barber.text.includes('confirmed'));assert(!('parse_mode' in client));
 assert.equal((await db.prepare('SELECT count(*) n FROM outbox WHERE booking_id=? AND state=\'sent\'').bind(b.id).first<Row>())!.n,2);
});
test('cancel supersedes queued creation; revoked staff receives no queued details',async()=>{
 await request('/api/me',201);await db.prepare("UPDATE barbers SET telegram_id=201 WHERE id='demo-a'").run();
 const b=await (await book(101)).json() as Row;
 assert.equal((await request('/api/bookings/'+b.id,101,'PATCH',{version:1,status:'cancelled'})).status,200);
 await db.prepare("UPDATE barbers SET telegram_id=NULL WHERE id='demo-a'").run();
 const sent:Row[]=[];await runNotifications(env,async(_env,_method,payload)=>{sent.push(payload as Row);return {ok:true,code:200,retry_after:0};});
 assert.equal(sent.length,1);assert.equal(sent[0].chat_id,101);assert(sent[0].text.startsWith('Գրանցումը չեղարկված է'));
 const rows=(await db.prepare('SELECT state,last_error FROM outbox WHERE booking_id=?').bind(b.id).all<Row>()).results;
 assert.equal(rows.filter(r=>r.last_error==='SUPERSEDED').length,2);assert.equal(rows.filter(r=>r.last_error==='ACCESS_REVOKED').length,1);
});
test('legacy text queues also suppress stale visits and revoked barber delivery',async()=>{
 await request('/api/me',201);await db.prepare("UPDATE barbers SET telegram_id=201 WHERE id='demo-a'").run();
 const b=await (await book(101)).json() as Row;await db.prepare("UPDATE outbox SET event_json=NULL,text='legacy message' WHERE booking_id=?").bind(b.id).run();
 assert.equal((await request('/api/bookings/'+b.id,101,'PATCH',{version:1,status:'cancelled'})).status,200);
 await db.prepare("UPDATE outbox SET event_json=NULL,text='legacy cancelled' WHERE booking_id=? AND state='pending'").bind(b.id).run();
 await db.prepare("UPDATE barbers SET telegram_id=NULL WHERE id='demo-a'").run();
 const sent:Row[]=[];await runNotifications(env,async(_env,_method,payload)=>{sent.push(payload as Row);return {ok:true,code:200,retry_after:0};});
 assert.equal(sent.length,1);assert.equal(sent[0].chat_id,101);assert.equal(sent[0].text,'legacy cancelled');
 const rows=(await db.prepare('SELECT last_error FROM outbox WHERE booking_id=?').bind(b.id).all<Row>()).results;assert.equal(rows.filter(r=>r.last_error==='SUPERSEDED').length,2);assert.equal(rows.filter(r=>r.last_error==='ACCESS_REVOKED').length,1);
});
test('reminders render the correct language and window without repeated delivery',async()=>{
 await db.prepare('DELETE FROM working_hours').run();
 for(let day=0;day<7;day++)await db.prepare("INSERT INTO working_hours(id,barber_id,weekday,start_minute,end_minute) VALUES(?,'demo-a',?,0,1440)").bind('reminder-day-'+day,day).run();
 function near(hours:number){let time=Math.ceil((Date.now()/1000+hours*3600)/300)*300;const minute=(time+14400)%86400/60;if(minute>1410)time+=(1440-minute)*60;return time;}
 const short=await (await book(101,near(1.2),'reminder_short')).json() as Row,day=await (await book(102,near(20),'reminder_day')).json() as Row;
 assert(short.id&&day.id);await request('/api/me/language',101,'PUT',{language:'ru'});
 await db.prepare("UPDATE outbox SET state='sent'").run();
 const sent:Row[]=[];const sender=async(_env:Env,_method:string,payload:unknown)=>{sent.push(payload as Row);return {ok:true,code:200,retry_after:0};};
 await runNotifications(env,sender);assert.equal(sent.length,2);assert(sent.find(s=>s.chat_id===101)!.text.startsWith('Скоро ваш визит'));assert(sent.find(s=>s.chat_id===102)!.text.startsWith('Գրանցման հիշեցում'));
 await runNotifications(env,sender);assert.equal(sent.length,2);
 const rows=(await db.prepare("SELECT id,event_json FROM outbox WHERE id LIKE '%:reminder:%'").all<Row>()).results;assert.equal(rows.length,2);assert(rows.some(r=>r.id===short.id+':1:reminder:2h'));assert(rows.some(r=>r.id===day.id+':1:reminder:24h'));
});
test('webhook replies use saved language and absent bot username cannot issue a broken invitation',async()=>{
 await request('/api/me/language',101,'PUT',{language:'ru'});
 await processWebhook(env,secret,{update_id:780,message:{from:{id:101},chat:{id:101,type:'private'},text:'/start'}});
 const reply=await db.prepare("SELECT text FROM outbox WHERE id='update:780'").first<Row>();assert(reply!.text.includes('Реальные записи не принимаются'));assert(!reply!.text.includes('Ոչ պաշտոնական'));
 const r=await request('/api/owner/barbers/demo-a/invitation',1,'POST',{},undefined,{BOT_USERNAME:''});assert.equal(r.status,409);assert.equal((await r.json() as Row).error,'TELEGRAM_NOT_CONFIGURED');
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
test('retirement cancellation checks the reviewed revision even when the visit count is unchanged',async()=>{
 const first=await (await book(101)).json() as Row;
 const reviewed=await (await request('/api/owner/barbers/demo-a/future-bookings',1)).json() as Row;
 assert.equal(reviewed.barber.future_count,1);assert.equal(reviewed.items[0].id,first.id);
 assert.equal((await request('/api/owner/barbers/demo-a/future-bookings',101)).status,403);
 const body={version:reviewed.barber.version,archived:true,future_action:'cancel',expected_future_count:1,expected_bookings_revision:reviewed.barber.bookings_revision};
 assert.equal((await request('/api/owner/barbers/demo-a',1,'PATCH',{version:1,archived:true,future_action:'cancel'})).status,422);
 assert.equal((await request('/api/bookings/'+first.id,101,'PATCH',{version:1,status:'cancelled'})).status,200);
 const second=await (await book(102,slot(11),'retire_new')).json() as Row;
 assert.equal((await request('/api/owner/barbers/demo-a',1,'PATCH',body)).status,409);
 assert.equal((await db.prepare('SELECT status FROM bookings WHERE id=?').bind(second.id).first<Row>())!.status,'confirmed');
 const current=await (await request('/api/owner/barbers/demo-a/future-bookings',1)).json() as Row;
 assert.equal((await request('/api/owner/barbers/demo-a',1,'PATCH',{...body,expected_bookings_revision:current.barber.bookings_revision})).status,200);
 assert.equal((await db.prepare("SELECT archived,telegram_id FROM barbers WHERE id='demo-a'").first<Row>())!.archived,1);
 assert.equal((await db.prepare('SELECT status FROM bookings WHERE id=?').bind(second.id).first<Row>())!.status,'cancelled');
 assert.equal((await db.prepare('SELECT count(*) n FROM bookings').first<Row>())!.n,2);
 const notice=await db.prepare('SELECT event_json FROM outbox WHERE booking_id=? AND state=\'pending\'').bind(second.id).first<Row>();assert.equal(JSON.parse(notice!.event_json).kind,'cancelled');
 assert.equal((await request('/api/owner/barbers/demo-a',1,'PATCH',{...body,expected_bookings_revision:current.barber.bookings_revision})).status,409);
});
test('concurrent retirement and new booking either closes the profile or requires a fresh review',async()=>{
 const first=await (await book(101)).json() as Row;
 const snapshot=await (await request('/api/owner/barbers/demo-a/future-bookings',1)).json() as Row;
 const [retired,created]=await Promise.all([request('/api/owner/barbers/demo-a',1,'PATCH',{version:snapshot.barber.version,archived:true,future_action:'cancel',expected_future_count:1,expected_bookings_revision:snapshot.barber.bookings_revision}),book(102,slot(11),'retire_race')]);
 assert([200,409].includes(retired.status));const barber=await db.prepare("SELECT archived FROM barbers WHERE id='demo-a'").first<Row>();
 if(retired.status===200){assert.equal(created.status,409);assert.equal(barber!.archived,1);assert.equal((await db.prepare("SELECT count(*) n FROM bookings WHERE status='confirmed'").first<Row>())!.n,0);}
 else{assert.equal(created.status,201);assert.equal(barber!.archived,0);assert.equal((await db.prepare('SELECT status FROM bookings WHERE id=?').bind(first.id).first<Row>())!.status,'confirmed');}
});
test('owner transfers a visit with snapshots intact and notifies client plus both active barbers',async()=>{
 for(const [id,name]of [[201,'demo-a'],[202,'demo-b']] as const){await request('/api/me',id);await db.prepare('UPDATE barbers SET telegram_id=? WHERE id=?').bind(id,name).run();}
 const b=await (await book(101,slot(),'transfer_book','demo-a','shave')).json() as Row;
 await db.prepare("UPDATE barber_services SET duration=60 WHERE barber_id='demo-b' AND service_id='shave'").run();
 await db.prepare("UPDATE barbers SET online_enabled=0 WHERE id='demo-b'").run();
 await db.prepare("UPDATE services SET active=0 WHERE id='shave'").run();
 const query='/api/slots?'+new URLSearchParams({date:new Date((slot()+14400)*1000).toISOString().slice(0,10),service_id:'shave',barber_id:'demo-b',booking_id:b.id});
 assert.equal((await request(query,101)).status,422);assert.equal((await request(query,1)).status,200);
 assert.equal((await request('/api/bookings/'+b.id,201,'PATCH',{version:1,barber_id:'demo-b'})).status,403);
 assert.equal((await request('/api/bookings/'+b.id,1,'PATCH',{version:1,barber_id:'demo-b'})).status,200);
 const saved=await db.prepare('SELECT * FROM bookings WHERE id=?').bind(b.id).first<Row>();assert.equal(saved!.barber_id,'demo-b');assert.equal(saved!.ends_at-saved!.starts_at,b.ends_at-b.starts_at);assert.equal(saved!.price_max,b.price_max);assert.equal(saved!.title_hy,b.title_hy);
 const sent:Row[]=[];await runNotifications(env,async(_env,_method,payload)=>{sent.push(payload as Row);return {ok:true,code:200,retry_after:0};});
 assert.deepEqual(sent.map(s=>s.chat_id).sort((a,b)=>a-b),[101,201,202]);assert(sent.find(s=>s.chat_id===201)!.text.startsWith('Այցը փոխանցվել է այլ վարպետի'));
});
test('conflicting or unsupported transfer rolls back assignment, queue and booking revision',async()=>{
 const b=await (await book(101)).json() as Row;assert.equal((await book(102,slot(),'transfer_busy','demo-b')).status,201);
 const before=await db.prepare("SELECT bookings_revision FROM barbers WHERE id='demo-a'").first<Row>();
 assert.equal((await request('/api/bookings/'+b.id,1,'PATCH',{version:1,barber_id:'demo-b'})).status,409);
 await db.prepare("DELETE FROM barber_services WHERE barber_id='demo-c' AND service_id='cut'").run();
 assert.equal((await request('/api/bookings/'+b.id,1,'PATCH',{version:1,barber_id:'demo-c'})).status,409);
 const saved=await db.prepare('SELECT * FROM bookings WHERE id=?').bind(b.id).first<Row>();assert.equal(saved!.version,1);assert.equal(saved!.barber_id,'demo-a');
 assert.equal((await db.prepare("SELECT bookings_revision FROM barbers WHERE id='demo-a'").first<Row>())!.bookings_revision,before!.bookings_revision);
 assert.equal((await db.prepare('SELECT count(*) n FROM outbox WHERE booking_id=?').bind(b.id).first<Row>())!.n,1);
});
test('one-time invitations bind only an allowed private Telegram account',async()=>{
 const invite=await (await request('/api/owner/barbers/demo-a/invitation',1,'POST',{})).json() as Row;
 const code=invite.url.split('start=')[1];
 const update={update_id:500,message:{from:{id:201},chat:{id:201,type:'private'},text:`/start ${code}`}};
 await processWebhook(env,secret,update);await processWebhook(env,secret,update);
 assert.equal((await request('/api/me',201).then(r=>r.json()) as Row).barberId,'demo-a');
 await processWebhook(env,secret,{...update,update_id:501,message:{...update.message,from:{id:202},chat:{id:202,type:'private'}}});
 assert((await db.prepare("SELECT text FROM outbox WHERE id='update:501'").first<Row>())!.text.includes('Հրավերն'));
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

const dayOf=(time:number)=>new Date((time+14400)*1000).toISOString().slice(0,10);
const override=(day:string,hours:{start_minute:number;end_minute:number}[],version:number|null=null,id=1)=>request(`/api/staff/demo-a/schedule/dates/${day}`,id,'PUT',{hours,version});
test('date-specific hours replace weekly hours and an empty override closes only that barber',async()=>{
 const day=dayOf(slot()),readSlots=async(barber='demo-a')=>(await (await request(`/api/slots?service_id=cut&barber_id=${barber}&date=${day}`)).json() as Row).slots as Row[];
 assert.equal((await override(day,[])).status,200);assert.equal((await readSlots()).length,0);
 assert((await readSlots('demo-b')).some(s=>s.starts_at===slot()));assert.equal((await book(101)).status,409);
 assert.equal((await request('/api/manual-bookings',1,'POST',{service_id:'cut',barber_id:'demo-a',starts_at:slot()},'closed_manual')).status,409);
 assert.equal((await override(day,[{start_minute:1080,end_minute:1200}],1)).status,200);
 const slots=await readSlots();assert(slots.some(s=>s.starts_at===slot(19)));assert(!slots.some(s=>s.starts_at===slot()));
 assert.equal((await book(101,slot(19))).status,201);
});
test('date overrides open a weekly day off and reject conflicting edits or removal atomically',async()=>{
 let start=slot();while(new Date((start+14400)*1000).getUTCDay()!==0)start+=86400;const day=dayOf(start);
 assert.equal((await override(day,[{start_minute:600,end_minute:720}])).status,200);
 const booking=await (await book(101,start)).json() as Row;assert(booking.id);
 assert.equal((await request('/api/staff/demo-a/schedule',1,'PUT',{hours:[]})).status,200);
 assert.equal((await override(day,[],1)).status,409);
 assert.equal((await request(`/api/staff/demo-a/schedule/dates/${day}`,1,'DELETE',{version:1})).status,409);
 let saved=await db.prepare("SELECT * FROM schedule_overrides WHERE barber_id='demo-a' AND day=?").bind(day).first<Row>();assert.equal(saved!.version,1);assert.equal(JSON.parse(saved!.hours_json)[0].start_minute,600);
 assert.equal((await override(day,[{start_minute:600,end_minute:780}],1)).status,200);
 assert.equal((await override(day,[{start_minute:600,end_minute:840}],1)).status,409);
 saved=await db.prepare("SELECT version FROM schedule_overrides WHERE barber_id='demo-a' AND day=?").bind(day).first<Row>();assert.equal(saved!.version,2);
 assert.equal((await request(`/api/bookings/${booking.id}`,101,'PATCH',{version:1,status:'cancelled'})).status,200);
 assert.equal((await request(`/api/staff/demo-a/schedule/dates/${day}`,1,'DELETE',{version:2})).status,200);
});
test('date schedule validates dates, intervals and staff scope; split hours preserve full intervals',async()=>{
 const day=dayOf(slot()),hours=[{start_minute:600,end_minute:660},{start_minute:690,end_minute:720}];
 assert.equal((await override(day,hours,null,101)).status,403);
 await request('/api/me',201);await db.prepare("UPDATE barbers SET telegram_id=201 WHERE id='demo-a'").run();
 assert.equal((await override(day,hours,null,201)).status,200);
 assert.equal((await request(`/api/staff/demo-b/schedule/dates/${day}`,201,'PUT',{hours})).status,403);
 for(const invalid of [[{start_minute:605,end_minute:600}],[{start_minute:600,end_minute:665},{start_minute:660,end_minute:720}],[{start_minute:601,end_minute:720}]])assert.equal((await override(day,invalid,1)).status,422);
 assert.equal((await override('2027-02-30',hours)).status,422);
 const slots=(await (await request(`/api/slots?service_id=cut&barber_id=demo-a&date=${day}`)).json() as Row).slots as Row[];
 assert(slots.some(s=>s.starts_at===slot(10)+1800));assert(!slots.some(s=>s.starts_at===slot(10)+2100));assert(slots.some(s=>s.starts_at===slot(11)+1800));
 await assert.rejects(()=>db.prepare("UPDATE schedule_overrides SET hours_json='[{\"start_minute\":600,\"end_minute\":660},{\"start_minute\":650,\"end_minute\":720}]' WHERE barber_id='demo-a' AND day=?").bind(day).run());
});
test('concurrent date edits and bookings cannot overwrite each other or leave visits outside hours',async()=>{
 const day=dayOf(slot());const [booking,schedule]=await Promise.all([book(101),override(day,[])]);
 const bookings=await db.prepare('SELECT id FROM bookings').all<Row>();
 if(bookings.results.length){assert.equal(booking.status,201);assert.equal(schedule.status,409);}else{assert.equal(booking.status,409);assert.equal(schedule.status,200);}
 assert.equal((await db.prepare('SELECT count(*) n FROM booking_schedule_violations').first<Row>())!.n,0);
 const nextDay=dayOf(slot()+86400);
 const results=await Promise.all([override(nextDay,[{start_minute:600,end_minute:720}]),override(nextDay,[{start_minute:900,end_minute:1020}])]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
});

test('calendar scopes staff to own visits, keeps archived history and bounds date ranges',async()=>{
 await book(101);await book(102,slot(11),'calendar_other','demo-b');const day=dayOf(slot()),query=`from=${day}&to=${day}`;
 assert.equal((await request('/api/calendar?'+query,101)).status,403);
 assert.equal(((await (await request('/api/calendar?'+query,1)).json() as Row).items as Row[]).length,2);
 await request('/api/me',201);await db.prepare("UPDATE barbers SET telegram_id=201 WHERE id='demo-a'").run();
 const own=(await (await request('/api/calendar?'+query,201)).json() as Row).items as Row[];assert.equal(own.length,1);assert.equal(own[0].barber_id,'demo-a');
 assert.equal((await request('/api/calendar?'+query+'&barber_id=demo-b',201)).status,403);
 assert.equal((await request('/api/calendar?'+query+'&cursor=invalid',1)).status,422);
 assert.equal((await request(`/api/calendar?from=${day}&to=${dayOf(slot()+31*86400)}`,1)).status,422);
 assert.equal((await request('/api/owner/barbers/demo-a',1,'PATCH',{version:1,archived:true,future_action:'keep'})).status,200);
 assert.equal(((await (await request('/api/calendar?'+query+'&barber_id=demo-a',1)).json() as Row).items as Row[]).length,1);
 assert.equal((await request('/api/calendar?'+query,201)).status,403);
});
test('calendar keyset pagination returns all 101 same-day appointments without duplicates',async()=>{
 await request('/api/me',1);await db.prepare("INSERT INTO clients(id,name) VALUES('calendar-a','Demo A'),('calendar-b','Demo B')").run();
 const records=Array.from({length:101},(_,i)=>{let minutes=Math.floor(i/2)*5;if(minutes>=240)minutes+=60;return {id:`cal-${i}`,client:i%2?'calendar-b':'calendar-a',barber:i%2?'demo-b':'demo-a',start:slot()+minutes*60};});
 await db.prepare(`INSERT INTO bookings(id,client_id,barber_id,service_id,title_hy,title_ru,price_min,price_max,starts_at,ends_at,status,source,created_by,idempotency_key,request_hash)
  SELECT json_extract(j.value,'$.id'),json_extract(j.value,'$.client'),json_extract(j.value,'$.barber'),s.id,s.title_hy,s.title_ru,s.price_min,s.price_max,
  json_extract(j.value,'$.start'),json_extract(j.value,'$.start')+300,'confirmed','manual',1,'calendar_key_'||j.key,'test'
  FROM json_each(?) j CROSS JOIN services s WHERE s.id='cut'`).bind(JSON.stringify(records)).run();
 const day=dayOf(slot()),path=`/api/calendar?from=${day}&to=${day}`;
 const first=await (await request(path,1)).json() as Row;assert.equal(first.items.length,100);assert(first.next_cursor);
 const second=await (await request(path+'&cursor='+encodeURIComponent(first.next_cursor),1)).json() as Row;assert.equal(second.items.length,1);assert.equal(second.next_cursor,null);
 assert.equal(new Set([...first.items,...second.items].map((b:Row)=>b.id)).size,101);
 const filtered=await (await request(path+'&barber_id=demo-a',1)).json() as Row;assert.equal(filtered.items.length,51);
});
test('owner block/unblock is atomic, preserves existing visits and rejects stale moderation',async()=>{
 const booking=await (await book(101)).json() as Row,path=`/api/owner/clients/${encodeURIComponent(booking.client_id)}/access`;
 assert.equal((await request('/api/owner/clients',101)).status,403);
 assert.equal((await request(path,101,'PATCH',{blocked:true,expected_blocked:false})).status,403);
 assert.equal((await request(path,1,'PATCH',{blocked:true,expected_blocked:false})).status,200);
 assert.equal((await db.prepare('SELECT status FROM bookings WHERE id=?').bind(booking.id).first<Row>())!.status,'confirmed');
 let denied=await book(101,slot(11),'blocked_client');assert.equal(denied.status,409);assert.equal((await denied.json() as Row).error,'CLIENT_BLOCKED');
 assert.equal((await request(`/api/bookings/${booking.id}`,101,'PATCH',{version:1,status:'cancelled'})).status,200);
 assert.equal((await request(path,1,'PATCH',{blocked:false,expected_blocked:false})).status,409);
 const list=await (await request('/api/owner/clients',1)).json() as Row;assert.equal(list.items[0].blocked,1);assert.equal(list.items[0].no_show_count,0);
 assert.equal((await request(path,1,'PATCH',{blocked:false,expected_blocked:true})).status,200);
 assert.equal((await book(101,slot(11),'unblocked_client')).status,201);
 const manual=await (await request('/api/manual-bookings',1,'POST',{service_id:'cut',barber_id:'demo-b',starts_at:slot()},'manual_client_access')).json() as Row;
 const manualAccess=await request(`/api/owner/clients/${manual.client_id}/access`,1,'PATCH',{blocked:true,expected_blocked:false});assert.equal(manualAccess.status,409);assert.equal((await manualAccess.json() as Row).error,'MANUAL_CLIENT');
 assert.equal((await db.prepare("SELECT count(*) n FROM audit_log WHERE action IN('client.block','client.unblock')").first<Row>())!.n,2);
});
