export function bookingLink(origin:string,telegramEntry?:string,barberId?:string|null,botUsername?:string):string;
export function linkedBarber(search:string,startParam:unknown,availableIds:string[]):string|null;
export function qrMatrix(value:string):boolean[][];
export function qrPixels(value:string,scale?:number):{size:number;data:Uint8ClampedArray};
