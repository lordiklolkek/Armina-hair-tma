import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { ownerOnly } from './auth';
import { audit, nowSeconds } from './booking';
import type { AppEnv, Row } from './types';

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
export const exports=new Hono<AppEnv>();
exports.get('/owner/exports/:dataset',ownerOnly,async c=>{
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
 await audit(c.env.DB,c.get('identity').id,'data.export',dataset).run();
 c.header('Content-Disposition',`attachment; filename="37-${dataset}-${parameters.after}.json"`);
 return c.json({format:'37-business-export',schema_version:1,dataset,generated_at:nowSeconds(),page_size:pageSize,through,after:parameters.after,next_cursor:hasMore?Number(page.at(-1)!.export_cursor):null,items});
});
