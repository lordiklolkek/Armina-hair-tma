import type { Context } from 'hono';
import type { AppEnv } from './types';
import { runNotifications } from './telegram';

// A real Worker context keeps delivery alive after the HTTP acknowledgement.
// Direct unit-test requests have no context and never call the live Bot API.
export function deferDelivery(c:Context<AppEnv>,target:string){
 let execution:{waitUntil(promise:Promise<unknown>):void};
 try{execution=c.executionCtx;}catch{return;}
 execution.waitUntil(runNotifications(c.env,undefined,target).catch(()=>{
  // The persisted lease/backoff is retained for cron. Do not log recipients.
  console.error(JSON.stringify({event:'notification_deferred'}));
 }));
}
