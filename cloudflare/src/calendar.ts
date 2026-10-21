import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv, Row } from './types';
import { dayInput, dayStart } from './booking';
export const calendar=new Hono<AppEnv>();
calendar.get('/calendar',async c=>{
 const who=c.get('identity');if(!who.owner&&!who.barberId)throw new HTTPException(403,{message:'FORBIDDEN'});
 const from=dayInput.parse(c.req.query('from')),to=dayInput.parse(c.req.query('to')),start=dayStart(from),end=dayStart(to)+86400;
 if(end<=start||end-start>31*86400)throw new HTTPException(422,{message:'DATE_RANGE_LIMIT'});
 const selected=z.string().min(1).max(80).optional().parse(c.req.query('barber_id'));
 if(!who.owner&&selected&&selected!==who.barberId)throw new HTTPException(403,{message:'FORBIDDEN'});
 const barber=who.owner?selected:who.barberId;
 const status=z.enum(['pending','confirmed','cancelled','completed','no_show']).optional().parse(c.req.query('status'));
 const conditions=['b.starts_at<?','b.ends_at>?'],values:any[]=[end,start];
 if(barber){conditions.push('b.barber_id=?');values.push(barber);}if(status){conditions.push('b.status=?');values.push(status);}
 if(c.req.query('cursor')){
  const raw=z.string().regex(/^\d{1,12}\.[A-Za-z0-9_-]{1,80}$/).parse(c.req.query('cursor'));
  const [time,id]=raw.split('.');conditions.push('(b.starts_at>? OR (b.starts_at=? AND b.id>?))');values.push(Number(time),Number(time),id);
 }
 const rows=(await c.env.DB.prepare(`SELECT b.*,c.name client_name,c.phone,bm.name barber_name FROM bookings b
  JOIN clients c ON c.id=b.client_id JOIN barbers bm ON bm.id=b.barber_id WHERE ${conditions.join(' AND ')} ORDER BY b.starts_at,b.id LIMIT 101`).bind(...values).all<Row>()).results;
 const items=rows.slice(0,100),last=items.at(-1);
 return c.json({items,next_cursor:rows.length>100?`${last!.starts_at}.${last!.id}`:null});
});
