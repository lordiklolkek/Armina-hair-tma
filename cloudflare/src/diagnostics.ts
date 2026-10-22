import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv, Row } from './types';
import { ownerOnly } from './auth';
import { audit, guard, nowSeconds } from './booking';
import { deferDelivery } from './delivery';

export const diagnostics=new Hono<AppEnv>();
const retryable=(error:unknown)=>error==='ATTEMPTS_EXHAUSTED'||/^TELEGRAM_(0|401|403|429|5\d\d)$/.test(String(error));
diagnostics.get('/owner/notifications',ownerOnly,async c=>{
 const state=z.enum(['pending','sending','sent','failed']).parse(c.req.query('state')||'failed');
 const cursor=z.string().max(160).regex(/^[A-Za-z0-9:_-]*$/).parse(c.req.query('cursor')||'');
 const [summary,list]=await c.env.DB.batch([
  c.env.DB.prepare('SELECT state,count(*) count FROM outbox GROUP BY state'),
  c.env.DB.prepare(`SELECT o.id,o.booking_id,o.state,o.attempts,o.last_error,o.next_attempt_at,
   COALESCE(b.title_hy,'') title_hy,COALESCE(b.title_ru,'') title_ru,json_extract(o.event_json,'$.audience') audience
   FROM outbox o LEFT JOIN bookings b ON b.id=o.booking_id WHERE o.state=? AND o.id>? ORDER BY o.id LIMIT 101`).bind(state,cursor)
 ]);
 const items=(list.results as Row[]).slice(0,100).map(row=>({...row,id:String(row.id),can_retry:row.state==='failed'&&retryable(row.last_error)}));
 return c.json({summary:summary.results,items,next_cursor:list.results.length>100?items.at(-1)!.id:null});
});
diagnostics.post('/owner/notifications/self-test',ownerOnly,async c=>{
 z.object({}).strict().parse(await c.req.json());
 if(!c.env.BOT_TOKEN)throw new HTTPException(503,{message:'TELEGRAM_NOT_CONFIGURED'});
 const who=c.get('identity'),id=`selftest:${who.id}:${Math.floor(nowSeconds()/300)}`;
 const text='37 Barbershop · Ծանուցումների փորձարկում։\nԲոտը կարող է ձեզ հաղորդագրություններ ուղարկել։ Սա առաքման ստուգում է․ իրական գրանցում չի ստեղծվել։';
 await c.env.DB.batch([c.env.DB.prepare('INSERT OR IGNORE INTO outbox(id,chat_id,text) VALUES(?,?,?)').bind(id,who.id,text),
  c.env.DB.prepare("INSERT OR IGNORE INTO audit_log(id,actor,action,entity_id) VALUES(?,?,'notification.selftest',?)").bind('audit:'+id,who.id,id)]);
 deferDelivery(c,id);
 return c.json(await c.env.DB.prepare('SELECT id,state,attempts,last_error FROM outbox WHERE id=?').bind(id).first());
});
diagnostics.post('/owner/notifications/:id/retry',ownerOnly,async c=>{
 z.object({}).strict().parse(await c.req.json());
 const id=z.string().min(1).max(160).regex(/^[A-Za-z0-9:_-]+$/).parse(c.req.param('id'));
 const job=await c.env.DB.prepare('SELECT state,last_error FROM outbox WHERE id=?').bind(id).first<Row>();
 if(!job)throw new HTTPException(404,{message:'NOT_FOUND'});
 if(job.state!=='failed'||!retryable(job.last_error))throw new HTTPException(409,{message:'NOT_RETRYABLE'});
 await c.env.DB.batch([...guard(c.env.DB,"EXISTS(SELECT 1 FROM outbox WHERE id=? AND state='failed' AND last_error=?)",id,job.last_error),
  c.env.DB.prepare("UPDATE outbox SET state='pending',attempts=0,next_attempt_at=?,last_error=NULL,lease_until=NULL,lease_token=NULL WHERE id=?").bind(nowSeconds(),id),
  audit(c.env.DB,c.get('identity').id,'notification.retry',id)]);
 return c.json({ok:true});
});
