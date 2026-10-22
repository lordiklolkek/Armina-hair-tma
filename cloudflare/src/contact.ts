import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv, Env, Row } from './types';
import { nowSeconds, guard, audit } from './booking';

export const contact=new Hono<AppEnv>();
export const contactEnabled=(env:Env)=>env.CONTACT_VERIFICATION_ENABLED==='true';
contact.get('/me/contact',async c=>{
 const user=await c.env.DB.prepare('SELECT phone_verified_at FROM users WHERE telegram_id=?').bind(c.get('identity').id).first<Row>();
 return c.json({enabled:contactEnabled(c.env),verified:Boolean(user?.phone_verified_at)});
});
contact.post('/me/contact-challenge',async c=>{
 z.object({}).strict().parse(await c.req.json());
 if(!contactEnabled(c.env)||!c.env.WEBHOOK_SECRET)throw new HTTPException(503,{message:'CONTACT_NOT_ENABLED'});
 const who=c.get('identity'),now=nowSeconds();
 await c.env.DB.batch([
  c.env.DB.prepare(`INSERT INTO contact_challenges(telegram_id,requested_at,expires_at) VALUES(?,?,?)
   ON CONFLICT(telegram_id) DO UPDATE SET requested_at=excluded.requested_at,expires_at=excluded.expires_at,consumed_at=NULL`).bind(who.id,now,now+600),
  audit(c.env.DB,who.id,'contact.request','self')
 ]);
 return c.json({expires_in:600});
});

// Only a secret-authenticated Bot API update may attest ownership. Never use
// a number or success callback supplied by Mini App JavaScript as evidence.
export function verifiedContactStatements(env:Env,update:Row,actor:number){
 const message=update.message,shared=message?.contact,now=nowSeconds();
 if(!contactEnabled(env)||!shared||message.forward_origin||message.forward_from||message.forward_sender_name||message.via_bot||message.sender_chat)return null;
 if(shared.user_id!==actor||!Number.isInteger(message.date)||message.date>now+30||message.date<now-600)return null;
 if(typeof shared.phone_number!=='string'||!/^\+?[1-9]\d{6,14}$/.test(shared.phone_number))return null;
 const phone='+'+shared.phone_number.replace(/^\+/,'');
 return [
  ...guard(env.DB,'EXISTS(SELECT 1 FROM contact_challenges WHERE telegram_id=? AND consumed_at IS NULL AND requested_at<=? AND expires_at>=? AND expires_at>=?)',actor,message.date,message.date,now),
  env.DB.prepare('UPDATE users SET phone=?,phone_verified_at=? WHERE telegram_id=?').bind(phone,now,actor),
  env.DB.prepare('UPDATE clients SET phone=? WHERE telegram_id=?').bind(phone,actor),
  env.DB.prepare('UPDATE contact_challenges SET consumed_at=? WHERE telegram_id=?').bind(now,actor),
  audit(env.DB,actor,'contact.verified','self')
 ];
}
