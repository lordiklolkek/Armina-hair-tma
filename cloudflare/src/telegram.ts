import type { Env, Row } from './types';
import { digest, equal, ids } from './auth';
import { nowSeconds, guard, audit } from './booking';
import { HTTPException } from 'hono/http-exception';
import { renderNotice } from './messages';
import { verifiedContactStatements, contactEnabled } from './contact';

export function launchKeyboard(env:Env,language:string,barberId?:string){
 try{
  const url=new URL(env.APP_URL||'');
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)return null;
  if(barberId)url.searchParams.set('barber',barberId);
  return {inline_keyboard:[[{text:language==='ru'?'Открыть 37 Barbershop':'Բացել 37 Barbershop',web_app:{url:url.toString()}}]]};
 }catch{return null;}
}

export async function telegramCall(env:Env,method:string,payload:unknown){
 if(!env.BOT_TOKEN)throw Error('TELEGRAM_NOT_CONFIGURED');
 try {
  const response=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)});
  const data=await response.json() as Row;
  if(!response.ok||!data.ok)return {ok:false,code:Number(data.error_code||response.status),retry_after:Number(data.parameters?.retry_after||0)};
  return {ok:true,code:200,retry_after:0};
 }catch{ return {ok:false,code:0,retry_after:0}; }
}
export async function processWebhook(env:Env,secret:string,update:Row){
 if(!env.WEBHOOK_SECRET||!equal(secret,env.WEBHOOK_SECRET))throw new HTTPException(403,{message:'FORBIDDEN'});
 if(!Number.isSafeInteger(update.update_id))throw new HTTPException(422,{message:'INVALID_UPDATE'});
 const message=update.message,actor=message?.from?.id;
 // Demo cannot collect genuine phone contacts or enroll unknown accounts.
 if(env.APP_MODE!=='demo'||!Number.isSafeInteger(actor)||message?.chat?.type!=='private'||message.chat.id!==actor||!ids(env.DEMO_USER_IDS).includes(String(actor)))return;
 const existing=await env.DB.prepare('SELECT update_id FROM telegram_updates WHERE update_id=?').bind(update.update_id).first();if(existing)return;
 const text=String(message.text||''),invite=/^\/start(?:@\w+)? join_([a-f0-9]{32})$/.exec(text);
 const preferred=/^\/start(?:@\w+)? barber_([A-Za-z0-9_-]{1,57})$/.exec(text);
 const user=await env.DB.prepare('SELECT language FROM users WHERE telegram_id=?').bind(actor).first<{language:string}>();
 const base=()=>[env.DB.prepare('INSERT INTO telegram_updates(update_id) VALUES(?)').bind(update.update_id),env.DB.prepare('INSERT OR IGNORE INTO users(telegram_id) VALUES(?)').bind(actor)];
 const statements:D1PreparedStatement[]=base();
 if(invite){
  const hash=await digest(invite[1]);
  statements.push(...guard(env.DB,`EXISTS(SELECT 1 FROM invitations i JOIN barbers b ON b.id=i.barber_id
   WHERE i.token_hash=? AND i.used_by IS NULL AND i.expires_at>unixepoch() AND b.active=1 AND b.archived=0 AND b.telegram_id IS NULL)
   AND NOT EXISTS(SELECT 1 FROM barbers WHERE telegram_id=?)`,hash,actor),
   env.DB.prepare('UPDATE barbers SET telegram_id=?,version=version+1 WHERE id=(SELECT barber_id FROM invitations WHERE token_hash=?)').bind(actor,hash),
   env.DB.prepare('UPDATE invitations SET used_by=? WHERE token_hash=?').bind(actor,hash),audit(env.DB,actor,'invitation.accept',hash));
 }
 const verification=message.contact?verifiedContactStatements(env,update,actor):null;
 if(verification)statements.push(...verification);
 const invalid=user?.language==='ru'?(invite?'Приглашение недействительно, уже использовано или доступ отозван. Попросите администратора создать новое.':'Номер не подтверждён. Откройте приложение, нажмите подтверждение номера и поделитесь собственным контактом через Telegram.'):
  (invite?'Հրավերն անվավեր է, արդեն օգտագործված է կամ մուտքը չեղարկված է։ Խնդրեք ադմինիստրատորին ստեղծել նորը։':'Համարը հաստատված չէ։ Բացեք հավելվածը, սկսեք համարի հաստատումը և Telegram-ի միջոցով ուղարկեք ձեր սեփական կոնտակտը։');
 const response=user?.language==='ru'?(invite?'ДЕМО · Доступ подтверждён.':message.contact?verification?'Номер подтверждён через Telegram.':contactEnabled(env)?invalid:'ДЕМО · Настоящие номера не сохраняются.':'37 Barbershop · Неофициальная демонстрация. Реальные записи не принимаются.'):
  (invite?'ԴԵՄՈ · Մուտքը հաստատված է։':message.contact?verification?'Համարը հաստատված է Telegram-ի միջոցով։':contactEnabled(env)?invalid:'ԴԵՄՈ · Իրական հեռախոսահամարները չեն պահպանվում։':'37 Barbershop · Ոչ պաշտոնական ցուցադրություն։ Իրական գրանցումներ չեն ընդունվում։');
 const keyboard=launchKeyboard(env,user?.language||'hy',preferred?.[1]);
 const reply=(body:string)=>env.DB.prepare('INSERT INTO outbox(id,chat_id,text,reply_markup) VALUES(?,?,?,?)').bind(`update:${update.update_id}`,actor,body,keyboard?JSON.stringify(keyboard):null);
 statements.push(reply(response));
 try{await env.DB.batch(statements);}catch(error){
  if(await env.DB.prepare('SELECT update_id FROM telegram_updates WHERE update_id=?').bind(update.update_id).first())return;
  // Invalid/replayed invitations and expired contact challenges are final
  // business outcomes. Acknowledge them instead of causing Telegram retries.
  if((invite||verification)&&String(error).includes('CHECK constraint failed: ok=1')){
   try{await env.DB.batch([...base(),reply(invalid)]);}catch(fallback){
    if(!await env.DB.prepare('SELECT update_id FROM telegram_updates WHERE update_id=?').bind(update.update_id).first())throw fallback;
   }
   return;
  }
  throw error;
 }
}
export async function runNotifications(env:Env,send=telegramCall){
 if(env.APP_MODE!=='demo'||!env.BOT_TOKEN)return;
 await env.DB.prepare("UPDATE outbox SET state='failed',last_error='ATTEMPTS_EXHAUSTED' WHERE attempts>=5 AND state IN('pending','sending') AND (lease_until IS NULL OR lease_until<?)").bind(nowSeconds()).run();
 // A bounded batch keeps each tick below the free invocation query limit.
 for(const [suffix,seconds,min] of [['24h',86400,7200],['2h',7200,0]] as const){
  await env.DB.prepare(`INSERT OR IGNORE INTO outbox(id,booking_id,chat_id,text,event_json)
   SELECT b.id||':'||b.version||':reminder:'||?,b.id,u.telegram_id,CASE u.language WHEN 'ru' THEN 'ДЕМО · Напоминание: '||b.title_ru ELSE 'ԴԵՄՈ · Հիշեցում՝ '||b.title_hy END||' · '||strftime('%d.%m.%Y %H:%M',b.starts_at,'unixepoch','+4 hours'),json_set(s.payload,'$.kind',?,'$.audience','client')
   FROM bookings b JOIN clients c ON c.id=b.client_id JOIN users u ON u.telegram_id=c.telegram_id JOIN booking_notification_snapshot s ON s.id=b.id
   WHERE b.status='confirmed' AND b.starts_at>unixepoch()+? AND b.starts_at<=unixepoch()+?`).bind(suffix,suffix==='24h'?'reminder24h':'reminder2h',min,seconds).run();
 }
 const due=(await env.DB.prepare("SELECT id FROM outbox WHERE (state='pending' AND next_attempt_at<=?) OR (state='sending' AND lease_until<?) ORDER BY next_attempt_at LIMIT 5").bind(nowSeconds(),nowSeconds()).all<{id:string}>()).results;
 for(const {id} of due){
  const lease=crypto.randomUUID();
  const job=await env.DB.prepare(`UPDATE outbox SET state='sending',lease_token=?,lease_until=?,attempts=attempts+1
   WHERE id=? AND attempts<5 AND ((state='pending' AND next_attempt_at<=?) OR (state='sending' AND lease_until<?)) RETURNING *`).bind(lease,nowSeconds()+120,id,nowSeconds(),nowSeconds()).first<Row>();
  if(!job)continue;
  if(!ids(env.DEMO_USER_IDS).includes(String(job.chat_id))){await env.DB.prepare("UPDATE outbox SET state='failed',last_error='NOT_DEMO_ACCOUNT' WHERE id=? AND lease_token=?").bind(id,lease).run();continue;}
  if(job.booking_id&&!job.event_json&&id.startsWith(job.booking_id+':')){
   const version=id.slice(String(job.booking_id).length+1).split(':')[0];
   if(/^[1-9]\d*$/.test(version)){
    const current=await env.DB.prepare('SELECT b.version,m.telegram_id,m.active,m.archived FROM bookings b JOIN barbers m ON m.id=b.barber_id WHERE b.id=?').bind(job.booking_id).first<Row>();
    const reason=!current||Number(version)!==current.version?'SUPERSEDED':id.endsWith(':barber')&&(!current.active||current.archived||current.telegram_id!==job.chat_id)?'ACCESS_REVOKED':null;
    if(reason){await env.DB.prepare("UPDATE outbox SET state='failed',last_error=?,lease_until=NULL WHERE id=? AND lease_token=?").bind(reason,id,lease).run();continue;}
   }
  }
  if(id.includes(':reminder:')){
   const current=await env.DB.prepare("SELECT id FROM bookings WHERE id=? AND status='confirmed' AND starts_at>? AND ? LIKE id||':'||version||':reminder:%'").bind(job.booking_id,nowSeconds(),id).first();
   if(!current){await env.DB.prepare("UPDATE outbox SET state='failed',last_error='SUPERSEDED' WHERE id=? AND lease_token=?").bind(id,lease).run();continue;}
  }
  let text=job.text;
  if(job.event_json){
   try{
    const payload=JSON.parse(job.event_json);
    const current=await env.DB.prepare('SELECT id FROM bookings WHERE id=? AND version=?').bind(job.booking_id,payload.version??-1).first();
    if(!current){await env.DB.prepare("UPDATE outbox SET state='failed',last_error='SUPERSEDED',lease_until=NULL WHERE id=? AND lease_token=?").bind(id,lease).run();continue;}
    if(payload.audience==='barber'&&!await env.DB.prepare('SELECT id FROM barbers WHERE id=? AND telegram_id=? AND active=1 AND archived=0').bind(payload.recipient_barber_id??'',job.chat_id).first()){
     await env.DB.prepare("UPDATE outbox SET state='failed',last_error='ACCESS_REVOKED',lease_until=NULL WHERE id=? AND lease_token=?").bind(id,lease).run();continue;
    }
    const user=await env.DB.prepare('SELECT language FROM users WHERE telegram_id=?').bind(job.chat_id).first<{language:string}>();text=renderNotice(payload,user?.language);
   }
   catch{await env.DB.prepare("UPDATE outbox SET state='failed',last_error='INVALID_PAYLOAD',lease_until=NULL WHERE id=? AND lease_token=?").bind(id,lease).run();continue;}
  }
  let markup:unknown;
  if(job.reply_markup){
   try{
    markup=JSON.parse(job.reply_markup);
    // Compare to a server-built keyboard, never trust an arbitrary stored URL.
    const url=new URL((markup as Row).inline_keyboard?.[0]?.[0]?.web_app?.url||'');
    const expected=launchKeyboard(env,(markup as Row).inline_keyboard?.[0]?.[0]?.text==='Открыть 37 Barbershop'?'ru':'hy',url.searchParams.get('barber')||undefined);
    if(!expected||JSON.stringify(expected)!==JSON.stringify(markup))throw Error();
   }catch{await env.DB.prepare("UPDATE outbox SET state='failed',last_error='INVALID_PAYLOAD',lease_until=NULL WHERE id=? AND lease_token=?").bind(id,lease).run();continue;}
  }
  const result=await send(env,'sendMessage',{chat_id:job.chat_id,text,...(markup?{reply_markup:markup}:{})});
  const failed=result.code===403||result.code===400||job.attempts>=5;
  await env.DB.prepare('UPDATE outbox SET text=?,state=?,last_error=?,next_attempt_at=?,lease_until=NULL WHERE id=? AND lease_token=?')
   .bind(text,result.ok?'sent':failed?'failed':'pending',result.ok?null:`TELEGRAM_${result.code}`,nowSeconds()+Math.max(result.retry_after||0,Math.min(3600,30*2**Number(job.attempts))),id,lease).run();
 }
 await env.DB.batch([env.DB.prepare('DELETE FROM rate_limits WHERE window<?').bind(Math.floor(Date.now()/60000)-60),env.DB.prepare('DELETE FROM telegram_updates WHERE processed_at<?').bind(nowSeconds()-7*86400),env.DB.prepare('DELETE FROM invitations WHERE expires_at<?').bind(nowSeconds()-86400),env.DB.prepare('DELETE FROM contact_challenges WHERE expires_at<?').bind(nowSeconds()-86400)]);
}
