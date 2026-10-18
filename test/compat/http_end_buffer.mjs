import http from 'node:http';
import { strict as assert } from 'node:assert';
const server = http.createServer((req,res)=>{const buffer=Buffer.from('original');res.end(buffer,()=>buffer.fill(120));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const text=await new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port:server.address().port},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve(text));}).on('error',reject);});
assert.equal(text, 'original');
console.log('end callback buffer ownership ok');
await new Promise(resolve=>server.close(resolve));
