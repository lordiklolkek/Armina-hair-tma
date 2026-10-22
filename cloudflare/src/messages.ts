import { z } from 'zod';
const notice=z.object({
 id:z.string().min(1).max(80),kind:z.enum(['created','moved','cancelled','updated','transferred_away','reminder24h','reminder2h']),audience:z.enum(['client','barber']),
 title_hy:z.string(),title_ru:z.string(),barber_name:z.string(),client_name:z.string(),
 client_phone:z.string().regex(/^\+[1-9]\d{6,14}$/).nullable().optional(),
 starts_at:z.number().int().positive(),ends_at:z.number().int().positive(),
 price_min:z.number().nonnegative(),price_max:z.number().nonnegative(),final_price:z.number().nonnegative().nullable(),
 status:z.enum(['pending','confirmed','cancelled','completed','no_show']),previous_starts_at:z.number().optional(),previous_barber_name:z.string().optional()
});
const words={
 ru:{created:'Запись подтверждена',newVisit:'Новая запись',moved:'Запись перенесена',cancelled:'Запись отменена',updated:'Запись изменена',transferred_away:'Визит передан другому мастеру',reminder24h:'Напоминание о записи',reminder2h:'Скоро ваш визит',barber:'Мастер',client:'Клиент',was:'Ранее',price:'Стоимость',final:'Итоговая цена',range:'Итоговую цену согласуйте с мастером.',status:'Статус',pending:'Ожидает подтверждения',confirmed:'Подтверждена',cancelledStatus:'Отменена',completed:'Завершена',no_show:'Неявка',demo:'ДЕМО · Это тестовый визит, не настоящая запись.'},
 hy:{created:'Գրանցումը հաստատված է',newVisit:'Նոր գրանցում',moved:'Գրանցումը տեղափոխված է',cancelled:'Գրանցումը չեղարկված է',updated:'Գրանցումը փոփոխված է',transferred_away:'Այցը փոխանցվել է այլ վարպետի',reminder24h:'Գրանցման հիշեցում',reminder2h:'Ձեր այցը շուտով է',barber:'Վարպետ',client:'Հաճախորդ',was:'Նախկինում',price:'Արժեքը',final:'Վերջնական գին',range:'Վերջնական գինը համաձայնեցրեք վարպետի հետ։',status:'Կարգավիճակ',pending:'Սպասում է հաստատման',confirmed:'Հաստատված',cancelledStatus:'Չեղարկված',completed:'Ավարտված',no_show:'Չի ներկայացել',demo:'ԴԵՄՈ · Սա փորձնական այց է, ոչ իրական գրանցում։'}
};
export function renderNotice(raw:unknown,language:unknown='hy'){
 const n=notice.parse(raw),lang=language==='ru'?'ru':'hy',w=words[lang];
 const date=(v:number)=>new Intl.DateTimeFormat(lang==='ru'?'ru-RU':'hy-AM',{timeZone:'Asia/Yerevan',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(v*1000);
 const money=(v:number)=>new Intl.NumberFormat(lang==='ru'?'ru-RU':'hy-AM').format(v)+' ֏';
 const header=n.kind==='created'&&n.audience==='barber'?w.newVisit:w[n.kind];
 const amount=n.final_price!==null?money(n.final_price):n.price_min===n.price_max?money(n.price_min):`${money(n.price_min)} – ${money(n.price_max)}`;
 const time=new Intl.DateTimeFormat(lang==='ru'?'ru-RU':'hy-AM',{timeZone:'Asia/Yerevan',hour:'2-digit',minute:'2-digit',hour12:false}).format(n.ends_at*1000);
 const lines=[header,n[`title_${lang}`],`${date(n.starts_at)} – ${time}`,`${w.barber}: ${n.barber_name}`];
 if(n.kind==='moved'||n.kind==='transferred_away')lines.push(`${w.was}: ${date(n.previous_starts_at??n.starts_at)} · ${n.previous_barber_name??n.barber_name}`);
 if(n.audience==='barber'){
  lines.push(`${w.client}: ${n.client_name}`);
  if(n.client_phone&&n.kind!=='transferred_away')lines.push(`${lang==='ru'?'Телефон':'Հեռախոս'}: ${n.client_phone}`);
 }
 lines.push(`${n.final_price!==null?w.final:w.price}: ${amount}`);
 if(n.final_price===null&&n.price_min!==n.price_max)lines.push(w.range);
 if(n.kind==='updated')lines.push(`${w.status}: ${n.status==='cancelled'?w.cancelledStatus:w[n.status]}`);
 lines.push(w.demo);
 return lines.join('\n');
}
