import qrcode from './vendor/qrcode.js';
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(value);
export function bookingLink(origin,telegramEntry='',barberId=null,botUsername=''){
 if(barberId!==null&&!validId(barberId))throw Error('INVALID_BARBER');
 const telegram=/^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}(?:\/[A-Za-z0-9_]{1,64})?$/.test(telegramEntry);
 const bot=!telegram&&/^[A-Za-z0-9_]{5,32}$/.test(botUsername)&&(!barberId||barberId.length<=57);
 const url=telegram?new URL(telegramEntry):bot?new URL('https://t.me/'+botUsername):new URL('/',origin);
 if(!['https:','http:'].includes(url.protocol))throw Error('INVALID_ORIGIN');
 if(barberId)url.searchParams.set(telegram?'startapp':bot?'start':'barber',telegram||bot?'barber_'+barberId:barberId);
 else if(bot)url.searchParams.set('start','booking');
 return url.toString();
}
export function linkedBarber(search,startParam,availableIds){
 const fromQuery=new URLSearchParams(search).get('barber');
 const candidates=[fromQuery,typeof startParam==='string'&&startParam.startsWith('barber_')?startParam.slice(7):null];
 return candidates.find(id=>validId(id)&&availableIds.includes(id))||null;
}
export function qrMatrix(value){
 const qr=qrcode(0,'M');qr.addData(value,'Byte');qr.make();
 return Array.from({length:qr.getModuleCount()},(_,row)=>Array.from({length:qr.getModuleCount()},(_,col)=>qr.isDark(row,col)));
}
export function qrPixels(value,scale=6){
 const matrix=qrMatrix(value),size=(matrix.length+8)*scale,data=new Uint8ClampedArray(size*size*4);data.fill(255);
 for(let row=0;row<matrix.length;row++)for(let col=0;col<matrix.length;col++)if(matrix[row][col]){
  for(let y=0;y<scale;y++)for(let x=0;x<scale;x++){const i=(((row+4)*scale+y)*size+(col+4)*scale+x)*4;data[i]=data[i+1]=data[i+2]=0;}
 }return {size,data};
}
