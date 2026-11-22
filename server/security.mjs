const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2,'0')).join('');
const unhex = s => Uint8Array.from(s.match(/../g) || [], x => parseInt(x,16));
export const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const digest = async text => hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
// PBKDF2-SHA256, 600,000 iterations, individual 128-bit salts. No plaintext in the database.
export async function hashPassword(password, salt = hex(crypto.getRandomValues(new Uint8Array(16)))) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:unhex(salt),iterations:600000},key,256);
  return `pbkdf2$600000$${salt}$${hex(bits)}`;
}
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  for (let i=0;i<Math.max(a.length,b.length);i++) diff |= (a.charCodeAt(i)||0) ^ (b.charCodeAt(i)||0);
  return diff === 0;
}
export async function verifyPassword(password, hash) {
  return equal(await hashPassword(password,hash.split('$')[2]), hash);
}
export class HttpError extends Error { constructor(status,message){super(message);this.status=status;} }
export const assert = (condition,status,message) => {if(!condition)throw new HttpError(status,message);};
export async function body(request) {
  assert((request.headers.get('content-type')||'').startsWith('application/json'),415,'Ожидается JSON.');
  const reader=request.body?.getReader(); let length=0, chunks=[];
  if(reader)for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>16384){await reader.cancel();throw new HttpError(413,'Слишком большой запрос.');}chunks.push(value);}
  try{const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}const parsed=JSON.parse(new TextDecoder().decode(bytes));assert(parsed && !Array.isArray(parsed) && typeof parsed==='object',400,'Некорректный запрос.');return parsed;}catch(e){if(e instanceof HttpError)throw e;throw new HttpError(400,'Некорректный JSON.');}
}
export const validDate = s => typeof s==='string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s;
export const moscowDate = now => new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
