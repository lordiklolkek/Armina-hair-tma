import type { Env, Row } from './types';
import { nowSeconds } from './booking';

async function telegram(env:Env,method:string,payload:Row){
 const response=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)});
 const body=await response.json() as Row;if(!response.ok||!body.ok)throw Error('MENU_REQUEST_FAILED');return body.result;
}
// A separately enabled, single-attempt presentation update. No webhook writes.
export async function updateArmenianMenu(env:Env,call=telegram){
 if(env.TELEGRAM_MENU_LABEL_REQUEST!=='armenian-v1'||env.APP_MODE!=='demo'||!env.BOT_TOKEN)return;
 const id='menu:armenian-v1',now=nowSeconds();
 const claimed=await env.DB.prepare('INSERT OR IGNORE INTO integration_status(id,payload,checked_at) VALUES(?,?,?)').bind(id,JSON.stringify({state:'running'}),now).run();
 if(!claimed.meta.changes)return;
 let state='failed';
 try{
  const origin=new URL(env.APP_URL||'');
  if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash)throw Error();
  const bot=await call(env,'getMe',{});
  if(!env.BOT_USERNAME||String(bot?.username||'').toLowerCase()!==env.BOT_USERNAME.toLowerCase())throw Error();
  const menu=await call(env,'getChatMenuButton',{});
  if(menu?.type!=='web_app'||new URL(menu.web_app?.url||'').toString()!==origin.toString())throw Error();
  if(menu.text!=='Գրանցվել')await call(env,'setChatMenuButton',{menu_button:{type:'web_app',text:'Գրանցվել',web_app:{url:menu.web_app.url}}});
  const verified=await call(env,'getChatMenuButton',{});
  if(verified?.type!=='web_app'||verified.text!=='Գրանցվել'||verified.web_app?.url!==menu.web_app.url)throw Error();
  state='complete';
 }catch{/* An uncertain write needs inspection, never an automatic retry. */}
 await env.DB.prepare('UPDATE integration_status SET payload=?,checked_at=? WHERE id=?').bind(JSON.stringify({state}),nowSeconds(),id).run();
}
