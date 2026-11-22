import {api} from './api.mjs';
export async function dispatch(request,env,assets){
  const path=new URL(request.url).pathname;
  let res;
  if(path.startsWith('/api/'))res=await api(request,env);
  else if(['GET','HEAD'].includes(request.method)&&Object.hasOwn(assets,path)){
    const [type,content]=assets[path];res=new Response(request.method==='HEAD'?null:content,{headers:{'Content-Type':type}});
  }else res=new Response('Страница не найдена',{status:404});
  const headers=new Headers(res.headers);
  headers.set('Cache-Control','no-store');
  headers.set('X-Content-Type-Options','nosniff');
  headers.set('Referrer-Policy','same-origin');
  headers.set('X-Frame-Options','DENY');
  headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  if(new URL(request.url).protocol==='https:')headers.set('Strict-Transport-Security','max-age=31536000');
  return new Response(res.body,{status:res.status,headers});
}
