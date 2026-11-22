import {createServer} from 'node:net';

export function localAddress() {
  const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||8787);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT должен быть целым числом от 1 до 65535.');
  const connectHost=host==='0.0.0.0'?'127.0.0.1':host==='::'?'::1':host;
  return {host,port,url:`http://${connectHost.includes(':')?'['+connectHost+']':connectHost}:${port}`};
}

export function portAvailable({host,port}) {
  return new Promise((resolve,reject)=>{
    const probe=createServer();
    probe.once('error',error=>error.code==='EADDRINUSE'?resolve(false):reject(error));
    probe.listen(port,host,()=>probe.close(()=>resolve(true)));
  });
}

export async function reportOccupied({host,port,url}) {
  let portal=false;
  try {
    const signal=AbortSignal.timeout(2500);
    const [health,page]=await Promise.all([
      fetch(url+'/api/health',{signal,redirect:'error'}),
      fetch(url+'/',{signal,redirect:'error'})
    ]);
    const [data,html]=await Promise.all([health.json(),page.text()]);
    portal=health.ok&&data.ok===true&&page.ok&&html.includes('<title>Деканат рядом</title>')&&html.includes('src="/app.js"');
  } catch {}
  if(portal){
    console.log(`Деканат рядом уже запущен: ${url}`);
    console.log('Откройте эту ссылку в браузере. Повторный запуск не нужен.');
  } else {
    console.error(`Адрес ${host}:${port} занят другим процессом или портал пока не отвечает.`);
    console.error('Остановите процесс, занявший порт, или выберите другой порт:');
    console.error(`PORT=${port===65535?8787:port+1} ./start.command`);
  }
  return portal;
}
