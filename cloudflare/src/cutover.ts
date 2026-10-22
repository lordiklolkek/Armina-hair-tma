import type { Env, Row } from './types';
import { nowSeconds } from './booking';

async function telegram(env:Env,method:string,payload:Row){
 const response=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)});
 const body=await response.json() as Row;if(!response.ok||!body.ok)throw Error('TELEGRAM_REQUEST_FAILED');return body.result;
}
async function renderGuard(){
 const response=await fetch('https://armina-hair-tma-demo.onrender.com/migration-status',{signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw Error('RENDER_NOT_VERIFIED');return response.json() as Promise<Row>;
}

// Set the unique request only AFTER human approval and a verified Render guard.
// The default config has no request and cannot change any bot settings.
export async function runApprovedCutover(env:Env,call=telegram,readGuard=renderGuard){
 const request=env.TELEGRAM_CUTOVER_REQUEST;if(!request)return;
 if(!/^[a-f0-9-]{36}$/.test(request)||env.APP_MODE!=='demo')return;
 const id='cutover:'+request,now=nowSeconds();
 const claimed=await env.DB.prepare('INSERT OR IGNORE INTO integration_status(id,payload,checked_at) VALUES(?,?,?)').bind(id,JSON.stringify({state:'running',checked_at:now}),now).run();
 if(!claimed.meta.changes)return;
 let step='preflight';
 try{
  const origin=new URL(env.APP_URL||'');
  if(origin.origin!=='https://barbershop-37-demo.barbershop-37.workers.dev'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw Error('INVALID_APP_URL');
  if(!env.BOT_TOKEN||!/^[A-Za-z0-9_-]{32,256}$/.test(env.WEBHOOK_SECRET||'')||!/^[a-f0-9]{40}$/.test(env.RENDER_GUARD_COMMIT||''))throw Error('MISSING_CONFIGURATION');
  if(!(env.LEGACY_CALLBACK_FORWARDING_ENABLED==='true'&&env.LEGACY_WEBHOOK_SECRET)&&env.LEGACY_CALLBACKS_RETIRED!=='true')throw Error('LEGACY_CALLBACK_NOT_READY');
  const guard=await readGuard();
  if(guard.guard!=='37-migration-v1'||guard.auto_configuration!==false||guard.source_commit!==env.RENDER_GUARD_COMMIT)throw Error('RENDER_NOT_VERIFIED');
  const bot=await call(env,'getMe',{});
  if(String(bot?.username||'').toLowerCase()!==String(env.BOT_USERNAME||'').toLowerCase())throw Error('BOT_MISMATCH');
  const target=origin.origin+'/telegram/webhook',prior=await call(env,'getWebhookInfo',{});
  if(![target,'https://armina-hair-tma-demo.onrender.com/telegram/webhook'].includes(prior?.url))throw Error('UNEXPECTED_WEBHOOK');
  step='webhook';
  await call(env,'setWebhook',{url:target,secret_token:env.WEBHOOK_SECRET,allowed_updates:['message','callback_query'],drop_pending_updates:false,max_connections:2});
  const verified=await call(env,'getWebhookInfo',{});if(verified?.url!==target)throw Error('WEBHOOK_NOT_VERIFIED');
  step='menu';
  await call(env,'setChatMenuButton',{menu_button:{type:'web_app',text:'Գրանցվել',web_app:{url:origin.origin}}});
  const menu=await call(env,'getChatMenuButton',{});if(menu?.web_app?.url!==origin.origin&&menu?.web_app?.url!==origin.origin+'/')throw Error('MENU_NOT_VERIFIED');
  await env.DB.prepare('UPDATE integration_status SET payload=?,checked_at=? WHERE id=?').bind(JSON.stringify({state:'complete',step:'verified',checked_at:nowSeconds()}),nowSeconds(),id).run();
 }catch{
  // An uncertain network outcome requires inspection and a newly approved
  // request. Never automatically retry a credential-bearing write.
  await env.DB.prepare('UPDATE integration_status SET payload=?,checked_at=? WHERE id=?').bind(JSON.stringify({state:'failed',step,checked_at:nowSeconds()}),nowSeconds(),id).run();
 }
}
