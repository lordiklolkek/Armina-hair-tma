import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderNotice } from '../src/messages';
const sample={id:'abcdef12-0000',kind:'created',audience:'client',title_hy:'Կտրվածք',title_ru:'Стрижка',barber_name:'Վարպետ',client_name:'Тестовый клиент',starts_at:1792746000,ends_at:1792747800,price_min:2000,price_max:2000,final_price:null,status:'confirmed'};
test('notification uses Armenian by default and hides client name from client copy',()=>{
 const text=renderNotice(sample);assert(text.startsWith('Գրանցումը հաստատված է\nԿտրվածք'));assert(text.includes('ԴԵՄՈ'));assert(!text.includes(sample.client_name));assert(!text.includes('AMD'));assert(!text.includes('2000–2000'));
});
test('Russian transfer explains previous appointment and preserves agreed final price',()=>{
 const text=renderNotice({...sample,kind:'moved',previous_starts_at:sample.starts_at-3600,previous_barber_name:'Прежний мастер',final_price:3500},'ru');
 assert(text.startsWith('Запись перенесена\nСтрижка'));assert(text.includes('Ранее:'));assert(text.includes('Прежний мастер'));assert.match(text,/Итоговая цена: 3\s500 ֏/);assert(!text.includes('Итоговую цену согласуйте'));
});
test('barber notifications and status names are localized; range disclaimer is explicit',()=>{
 const text=renderNotice({...sample,kind:'updated',audience:'barber',status:'no_show',price_max:4000},'ru');
 assert(text.includes('Клиент: Тестовый клиент'));assert(text.includes('Статус: Неявка'));assert(text.includes('Итоговую цену согласуйте с мастером.'));assert(!text.includes('no_show'));
 assert.throws(()=>renderNotice({...sample,kind:'unknown'}));
});
