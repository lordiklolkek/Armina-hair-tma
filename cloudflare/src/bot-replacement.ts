import type { Env, Row } from './types';
import { nowSeconds } from './booking';

type Method='getMe'|'getWebhookInfo';
async function readCandidate(env:Env,method:Method){
 try{
  const response=await fetch(`https://api.telegram.org/bot${env.NEXT_BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(8000)});
  const body=await response.json() as Row;
  return response.ok&&body.ok?body.result as Row:null;
 }catch{return null;}
}
// Inspection only: never configures either bot or selects an active token.
export async function inspectReplacementBot(env:Env,read=readCandidate){
 if(env.APP_MODE!=='demo'||!env.NEXT_BOT_TOKEN||!env.NEXT_BOT_USERNAME)return null;
 const expected=env.NEXT_BOT_USERNAME;
 if(!/^[A-Za-z0-9_]{5,32}$/.test(expected))return null;
 const result:Row={configured:true,expected_username:expected,ready:false,reason:'CANDIDATE_UNAVAILABLE',checked_at:nowSeconds()};
 const bot=await read(env,'getMe');
 if(bot){
  if(!Number.isSafeInteger(bot.id)||bot.id<=0||bot.is_bot!==true||String(bot.username||'').toLowerCase()!==expected.toLowerCase()||String(bot.id)!==env.NEXT_BOT_TOKEN.split(':')[0])result.reason='BOT_MISMATCH';
  else if(String(bot.id)===(env.BOT_TOKEN||'').split(':')[0])result.reason='SAME_BOT';
  else{
   result.bot_id=bot.id;result.username=expected;
   const hook=await read(env,'getWebhookInfo');
   try{
    const app=new URL(env.APP_URL||'');
    if(app.protocol!=='https:'||app.pathname!=='/'||app.search||app.hash||app.username||app.password)throw Error();
    if(hook&&typeof hook.url==='string'){
     const matches=hook.url===''||hook.url===new URL('/telegram/webhook',app).toString();
     result.webhook_state=hook.url===''?'empty':matches?'same_app':'other';
     result.pending_updates=Number.isSafeInteger(hook.pending_update_count)?hook.pending_update_count:null;
     result.ready=matches;result.reason=matches?'READY_FOR_APPROVAL':'EXISTING_WEBHOOK';
    }
   }catch{result.reason='INVALID_APP_URL';}
  }
 }
 // Never persist raw Telegram error text, token, or an arbitrary webhook URL.
 await env.DB.prepare('INSERT INTO integration_status(id,payload,checked_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,checked_at=excluded.checked_at')
  .bind('replacement:'+expected,JSON.stringify(result),result.checked_at).run();
 return result;
}

export async function refreshReplacementProbe(env:Env){
 if(env.ACTIVE_BOT==='next'||!env.NEXT_BOT_TOKEN||!env.NEXT_BOT_USERNAME||env.APP_MODE!=='demo')return;
 const prior=await env.DB.prepare('SELECT checked_at FROM integration_status WHERE id=?').bind('replacement:'+env.NEXT_BOT_USERNAME).first<{checked_at:number}>();
 if(prior&&prior.checked_at>nowSeconds()-300)return;
 return inspectReplacementBot(env);
}

async function candidateCall(env:Env,method:string,payload:Row){
 const response=await fetch(`https://api.telegram.org/bot${env.NEXT_BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)});
 const body=await response.json() as Row;if(!response.ok||!body.ok)throw Error('CANDIDATE_REQUEST_FAILED');return body.result as Row;
}
// Enable a unique request only after human approval. Original bot is never written.
export async function runApprovedReplacement(env:Env,call=candidateCall){
 const request=env.BOT_REPLACEMENT_REQUEST;
 if(!request||!/^[a-f0-9-]{36}$/.test(request)||env.ACTIVE_BOT||env.APP_MODE!=='demo')return;
 const id='replacement-cutover:'+request;
 const claimed=await env.DB.prepare('INSERT OR IGNORE INTO integration_status(id,payload,checked_at) VALUES(?,?,?)').bind(id,JSON.stringify({state:'running',step:'preflight'}),nowSeconds()).run();
 if(!claimed.meta.changes)return;
 let step='preflight';
 try{
  if(!env.NEXT_WEBHOOK_SECRET||!/^[A-Za-z0-9_-]{32,256}$/.test(env.NEXT_WEBHOOK_SECRET)||env.NEXT_WEBHOOK_SECRET===env.WEBHOOK_SECRET)throw Error();
  const ready=await inspectReplacementBot(env,async(e,m)=>call(e,m,{}));
  if(!ready?.ready)throw Error();
  const busy=await env.DB.prepare("SELECT count(*) count FROM outbox WHERE state IN('pending','sending')").first<Row>();
  if(busy?.count){step='outbox_busy';throw Error();}
  const origin=new URL(env.APP_URL!).origin,target=origin+'/telegram/webhook';
  step='menu';
  await call(env,'setChatMenuButton',{menu_button:{type:'web_app',text:'Գրանցվել',web_app:{url:origin}}});
  const menu=await call(env,'getChatMenuButton',{});
  if(menu?.type!=='web_app'||menu.text!=='Գրանցվել'||new URL(menu.web_app?.url||'').toString()!==new URL(origin).toString())throw Error();
  step='webhook';
  await call(env,'setWebhook',{url:target,secret_token:env.NEXT_WEBHOOK_SECRET,allowed_updates:['message','callback_query'],drop_pending_updates:false,max_connections:2});
  const hook=await call(env,'getWebhookInfo',{});if(hook?.url!==target)throw Error();
  await env.DB.prepare('UPDATE integration_status SET payload=?,checked_at=? WHERE id=?').bind(JSON.stringify({state:'complete',step:'ready_for_activation',username:env.NEXT_BOT_USERNAME}),nowSeconds(),id).run();
 }catch{
  // Unknown write outcome: inspect actual state; never retry automatically.
  await env.DB.prepare('UPDATE integration_status SET payload=?,checked_at=? WHERE id=?').bind(JSON.stringify({state:'failed',step}),nowSeconds(),id).run();
 }
}
