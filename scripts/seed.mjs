import {localDb,migrate,defaultDbPath} from '../server/local-db.mjs';
import {fixtures} from './fixtures.mjs';
import {seed} from '../server/seed.mjs';
import {rmSync} from 'node:fs';
const path=defaultDbPath();
if(process.argv.includes('--reset')){
  if(!process.argv.includes('--confirm-delete-demo-data'))throw new Error('Сброс удаляет изменения. Добавьте --confirm-delete-demo-data и остановите сервер.');
  for(const suffix of ['','-wal','-shm'])rmSync(path+suffix,{force:true});
}
const db=localDb(path);migrate(db);console.log(await seed(db,await fixtures(),new Date().toISOString()));db.close();
