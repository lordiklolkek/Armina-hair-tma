import { HTTPException } from 'hono/http-exception';
import type { Env, Row } from './types';

// Retain old moderation buttons during the transition. No arbitrary forwarding
// destination or credential can be supplied by a client.
export async function forwardLegacyCallback(env:Env,update:Row,send:typeof fetch=fetch){
 if(env.LEGACY_CALLBACKS_RETIRED==='true'){
  const query=update.callback_query;
  if(!query||typeof query.id!=='string'||query.id.length>256)throw new HTTPException(422,{message:'INVALID_UPDATE'});
  if(!env.BOT_TOKEN)throw new HTTPException(503,{message:'LEGACY_CALLBACK_UNAVAILABLE'});
  {
   try{
    const response=await send(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({callback_query_id:query.id,text:'Նախորդ ցուցադրության կոճակ է։ Բացեք 37 Barbershop-ը բոտի ցանկից։ / Это кнопка старой демоверсии. Откройте 37 Barbershop через меню бота.',show_alert:true}),signal:AbortSignal.timeout(8000)});
    const result=await response.json() as Row;if(!response.ok||!result.ok)throw Error();
   }catch{throw new HTTPException(503,{message:'LEGACY_CALLBACK_UNAVAILABLE'});}
  }
  return;
 }
 if(env.LEGACY_CALLBACK_FORWARDING_ENABLED!=='true'||!env.LEGACY_WEBHOOK_SECRET)throw new HTTPException(503,{message:'LEGACY_CALLBACK_NOT_READY'});
 try{
  const response=await send('https://armina-hair-tma-demo.onrender.com/telegram/webhook',{
   method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':env.LEGACY_WEBHOOK_SECRET},body:JSON.stringify(update),signal:AbortSignal.timeout(8000)
  });
  if(!response.ok)throw Error();
 }catch{throw new HTTPException(503,{message:'LEGACY_CALLBACK_UNAVAILABLE'});}
}
