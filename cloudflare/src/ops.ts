import type { Env, Row } from './types';
import { ids } from './auth';
import { nowSeconds } from './booking';

// Bounded monitoring on the existing cron. Alerts contain no customer data.
// Telegram cannot report its own complete outage until delivery recovers.
export async function queueOperationalAlert(env:Env,connection?:Row){
 if(!['demo','live'].includes(env.APP_MODE)||env.OPS_ALERTS_ENABLED!=='true'||!env.BOT_TOKEN)return;
 const recipient=[...ids(env.ADMIN_IDS),...ids(env.OWNER_IDS)].find(id=>env.APP_MODE==='live'||ids(env.DEMO_USER_IDS).includes(id));
 if(!recipient)return;
 const now=nowSeconds();
 const queue=await env.DB.prepare(`SELECT sum(failed) failed,sum(delayed) delayed FROM (
  SELECT count(*) failed,0 delayed FROM outbox WHERE state='failed' AND next_attempt_at>?
   AND (last_error='ATTEMPTS_EXHAUSTED' OR last_error LIKE 'TELEGRAM_%') AND id NOT LIKE 'ops:%'
  UNION ALL SELECT 0,count(*) FROM outbox WHERE state='pending' AND next_attempt_at<? AND id NOT LIKE 'ops:%'
  UNION ALL SELECT 0,count(*) FROM outbox WHERE state='sending' AND lease_until<? AND id NOT LIKE 'ops:%'
 )`).bind(now-86400,now-600,now-600).first<Row>();
 const connectionFailed=connection&&(connection.ok!==true||connection.webhook_matches!==true||connection.last_error_at>now-600||connection.pending_updates>=10);
 if(!connectionFailed&&!queue?.failed&&!queue?.delayed)return;
 // One warning per six-hour window, also safe against concurrent cron runs.
 const id=`ops:${Math.floor(now/21600)}:${recipient}`;
 const text='37 Barbershop · Տեխնիկական զգուշացում\n'+
  (connectionFailed?'Telegram-ի կապը ստուգման կարիք ունի։\n':'')+
  (queue?.failed?'Որոշ ծանուցումներ չեն առաքվել։\n':'')+
  (queue?.delayed?'Որոշ ծանուցումների առաքումն ուշանում է։\n':'')+
  'Բացեք հավելվածի կառավարման բաժինը և ստուգեք ծանուցումների վիճակը։';
 await env.DB.prepare('INSERT OR IGNORE INTO outbox(id,chat_id,text) VALUES(?,?,?)').bind(id,Number(recipient),text).run();
}
