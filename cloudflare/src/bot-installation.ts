import { HTTPException } from 'hono/http-exception';
import type { Env } from './types';

// Preserve the original secret bindings for rollback. Activation is explicit.
export function activeBotEnv(raw:Env):Env{
 if(!raw.ACTIVE_BOT)return raw;
 if(raw.ACTIVE_BOT!=='next'||!raw.BOT_TOKEN||!raw.WEBHOOK_SECRET||!raw.NEXT_BOT_TOKEN||!raw.NEXT_WEBHOOK_SECRET||!raw.NEXT_BOT_USERNAME||!/^[A-Za-z0-9_]{5,32}$/.test(raw.NEXT_BOT_USERNAME)||!/^[A-Za-z0-9_-]{32,256}$/.test(raw.NEXT_WEBHOOK_SECRET))throw new HTTPException(503,{message:'BOT_INSTALLATION_NOT_READY'});
 const namespace=raw.NEXT_BOT_TOKEN.split(':')[0];
 if(!/^[1-9]\d{0,15}$/.test(namespace)||!Number.isSafeInteger(Number(namespace))||namespace===(raw.BOT_TOKEN||'').split(':')[0]||raw.NEXT_WEBHOOK_SECRET===raw.WEBHOOK_SECRET)throw new HTTPException(503,{message:'BOT_INSTALLATION_NOT_READY'});
 return {...raw,PREVIOUS_WEBHOOK_SECRET:raw.WEBHOOK_SECRET,
  BOT_TOKEN:raw.NEXT_BOT_TOKEN,BOT_USERNAME:raw.NEXT_BOT_USERNAME,WEBHOOK_SECRET:raw.NEXT_WEBHOOK_SECRET,
  TELEGRAM_UPDATE_NAMESPACE:namespace,MINI_APP_URL:undefined,
  LEGACY_CALLBACK_FORWARDING_ENABLED:'false',LEGACY_CALLBACKS_RETIRED:'true'};
}
