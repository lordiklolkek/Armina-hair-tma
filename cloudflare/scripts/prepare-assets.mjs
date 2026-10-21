import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const target=new URL('../public/vendor/',import.meta.url);
await mkdir(target,{recursive:true});
const source=await readFile(require.resolve('qrcode-generator'),'utf8');
await writeFile(new URL('qrcode.js',target),source+'\nexport default qrcode;\n');
console.log('Prepared QR asset from locked qrcode-generator package.');
