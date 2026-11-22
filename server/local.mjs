import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {localDb,migrate,defaultDbPath} from './local-db.mjs';
import {dispatch} from './http.mjs';
import {localAddress,reportOccupied} from './local-port.mjs';
const address=localAddress(),{port,host}=address;
const db=localDb(defaultDbPath());migrate(db);
const files={'/features.js':['text/javascript; charset=utf-8','features.js'],'/':['text/html; charset=utf-8','index.html'],'/app.js':['text/javascript; charset=utf-8','app.js'],'/management.js':['text/javascript; charset=utf-8','management.js'],'/styles.css':['text/css; charset=utf-8','styles.css'],'/portal.css':['text/css; charset=utf-8','portal.css'],'/favicon.svg':['image/svg+xml','favicon.svg']};
const server=createServer(async(req,res)=>{
  try{
    const origin=process.env.PUBLIC_ORIGIN||`http://${req.headers.host}`;
    const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);
    const request=new Request(new URL(req.url,origin),{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
    const assets={};const path=new URL(request.url).pathname;
    if(files[path])assets[path]=[files[path][0],await readFile(new URL('../public/'+files[path][1],import.meta.url),'utf8')];
    const response=await dispatch(request,{DB:db,CLIENT_IP:req.socket.remoteAddress,ADMIN_TOKEN:process.env.ADMIN_TOKEN},assets);
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(e){console.error(e.message);res.writeHead(500);res.end('Не удалось обработать запрос.');}
});
server.requestTimeout=15000;server.headersTimeout=10000;
server.on('error',async error=>{
  db.close();
  if(error.code==='EADDRINUSE')process.exitCode=await reportOccupied(address)?0:1;
  else {console.error(`Не удалось запустить портал: ${error.code||error.message}`);process.exitCode=1;}
});
server.listen(port,host,()=>console.log(`Local: ${address.url}`));
function stop(){server.close(()=>{db.close();process.exit(0);});}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
