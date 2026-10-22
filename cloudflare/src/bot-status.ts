import type { Env, Row } from './types';
import { nowSeconds } from './booking';

async function readTelegram(env:Env,method:'getMe'|'getWebhookInfo'|'getChatMenuButton'){
 try{
  const response=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(8000)});
  const body=await response.json() as Row;
  return response.ok&&body.ok?{ok:true,result:body.result as Row}:{ok:false,result:null};
 }catch{return {ok:false,result:null};}
}
// Read-only Bot API calls. Never register a webhook or change the bot menu.
export async function checkBotConnection(env:Env,read=readTelegram){
 if(!env.BOT_TOKEN||!['demo','live'].includes(env.APP_MODE))return;
 const bot=await read(env,'getMe'),webhook=await read(env,'getWebhookInfo'),menu=await read(env,'getChatMenuButton');
 let origin='',matches=false,menuOrigin='',menuPath='',menuMatches=false,menuHasQuery=false;
 try{const url=new URL(menu.result?.web_app?.url||'');menuOrigin=url.origin;menuPath=url.pathname.slice(0,100);menuHasQuery=Boolean(url.search||url.hash||url.username||url.password);menuMatches=url.toString()===new URL(env.APP_URL||'').toString();}catch{}
 try{const url=new URL(webhook.result?.url||'');origin=url.origin;matches=url.toString()===new URL('/telegram/webhook',env.APP_URL).toString();}catch{}
 const payload={ok:bot.ok&&webhook.ok,bot_username:/^[A-Za-z0-9_]{5,32}$/.test(bot.result?.username||'')?bot.result!.username:'',webhook_origin:origin,webhook_matches:matches,
  pending_updates:Number.isSafeInteger(webhook.result?.pending_update_count)?webhook.result!.pending_update_count:null,
  last_error_at:Number.isSafeInteger(webhook.result?.last_error_date)?webhook.result!.last_error_date:null,
  menu_type:menu.result?.type==='web_app'?'web_app':'other',
  menu_label:typeof menu.result?.text==='string'?menu.result.text.slice(0,64):'',
  menu_origin:menuOrigin,menu_path:menuPath,menu_matches:menuMatches,menu_has_query:menuHasQuery,
  secret_configured:Boolean(env.WEBHOOK_SECRET),checked_at:nowSeconds()};
 await env.DB.prepare('INSERT INTO integration_status(id,payload,checked_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,checked_at=excluded.checked_at').bind('telegram',JSON.stringify(payload),payload.checked_at).run();
 return payload;
}
