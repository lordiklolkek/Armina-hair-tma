import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { ownerOnly } from './auth';
import { audit, nowSeconds } from './booking';
import type { AppEnv, Env, Row } from './types';

// Explicit projections prevent future operational/credential columns from
// silently becoming part of a business-data download.
const collections:Record<string,string>={
 settings:'id,name,address,logo_url,advance_days,notice_minutes',
 users:'telegram_id,language,phone,phone_verified_at,blocked',
 barbers:'id,name,description,photo_url,active,online_enabled,archived,telegram_id,version',
 services:'id,title_hy,title_ru,description_hy,description_ru,price_min,price_max,duration,active,sort_order',
 barber_services:'barber_id,service_id,duration',
 working_hours:'id,barber_id,weekday,start_minute,end_minute',
 absences:'id,barber_id,starts_at,ends_at,kind',
 schedule_overrides:'barber_id,day,hours_json,version',
 clients:'id,telegram_id,name,phone',
 bookings:'id,client_id,barber_id,service_id,title_hy,title_ru,price_min,price_max,final_price,starts_at,ends_at,status,source,created_by,version,created_at',
 notes:'barber_id,client_id,text'
};
const pageSize=250;
const query=z.object({after:z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),through:z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()}).strict();
export async function sendExportDocument(env:Env,recipient:number,filename:string,contents:string,request:typeof fetch=fetch){
 if(!env.BOT_TOKEN)return false;
 const body=new FormData();body.set('chat_id',String(recipient));
 body.set('document',new Blob([contents],{type:'application/json'}),filename);
 try{
  const response=await request(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`,{method:'POST',body,signal:AbortSignal.timeout(8000)});
  const data=await response.json() as Row;return response.ok&&data.ok===true;
 }catch{return false;}
}
export function createExports(send=sendExportDocument){
 const routes=new Hono<AppEnv>();
 routes.on(['GET','POST'],'/owner/exports/:dataset',ownerOnly,async c=>{
 const deliver=c.req.method==='POST';
 if(deliver)z.object({delivery:z.literal('telegram')}).strict().parse(await c.req.json());
 const dataset=c.req.param('dataset');
 if(!Object.hasOwn(collections,dataset))throw new HTTPException(404,{message:'NOT_FOUND'});
 const entries=[...new URL(c.req.url).searchParams];
 if(new Set(entries.map(([key])=>key)).size!==entries.length)throw new HTTPException(422,{message:'INVALID_INPUT'});
 const parameters=query.parse(Object.fromEntries(entries));
 const through=parameters.through??Number((await c.env.DB.prepare(`SELECT COALESCE(MAX(rowid),0) maximum FROM ${dataset}`).first<Row>())!.maximum);
 if(through<parameters.after)throw new HTTPException(422,{message:'INVALID_INPUT'});
 const rows=(await c.env.DB.prepare(`SELECT rowid AS export_cursor,${collections[dataset]} FROM ${dataset} WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?`).bind(parameters.after,through,pageSize+1).all<Row>()).results;
 const page=rows.slice(0,pageSize),hasMore=rows.length>pageSize;
 const items=page.map(({export_cursor,...record})=>record);
 const data={format:'37-business-export',schema_version:1,dataset,generated_at:nowSeconds(),page_size:pageSize,through,after:parameters.after,next_cursor:hasMore?Number(page.at(-1)!.export_cursor):null,items};
 if(deliver){
  const who=c.get('identity'),window=Math.floor(nowSeconds()/60);
  const rate=await c.env.DB.prepare(`INSERT INTO rate_limits(key,window,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END,window=excluded.window RETURNING count`).bind(`export:${who.id}`,window).first<Row>();
  if(Number(rate?.count)>3)throw new HTTPException(429,{message:'RATE_LIMIT'});
  await audit(c.env.DB,who.id,'data.export.telegram.request',dataset).run();
  // Only the signed administrator can receive the server-generated file.
  if(!await send(c.env,who.id,`37-${dataset}-${parameters.after}.json`,JSON.stringify(data,null,2)))throw new HTTPException(503,{message:'SERVICE_UNAVAILABLE'});
  await audit(c.env.DB,who.id,'data.export.telegram.sent',dataset).run();
  return c.json({ok:true,next_cursor:data.next_cursor,through});
 }
 await audit(c.env.DB,c.get('identity').id,'data.export',dataset).run();
 c.header('Content-Disposition',`attachment; filename="37-${dataset}-${parameters.after}.json"`);
 return c.json(data);
 });
 return routes;
}
export const exports=createExports();
