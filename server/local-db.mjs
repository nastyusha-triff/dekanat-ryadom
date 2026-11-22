import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,readdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
export function localDb(path){
  if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
  const db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  class Statement{constructor(sql,args=[]){this.sql=sql;this.args=args;}bind(...args){return new Statement(this.sql,args);}async all(){return {results:db.prepare(this.sql).all(...this.args)};}async first(){return db.prepare(this.sql).get(...this.args)||null;}async run(){const r=db.prepare(this.sql).run(...this.args);return {meta:{changes:Number(r.changes)},success:true};}}
  return {prepare:sql=>new Statement(sql),async batch(statements){db.exec('BEGIN IMMEDIATE');try{const results=[];for(const s of statements){const r=db.prepare(s.sql).run(...s.args);results.push({meta:{changes:Number(r.changes)},success:true});}db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}},exec:sql=>db.exec(sql),close:()=>db.close(),raw:db};
}
export function migrate(db){
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)');
  const dir=new URL('../drizzle/',import.meta.url);
  for(const name of readdirSync(dir).filter(n=>n.endsWith('.sql')).sort())if(!db.raw.prepare('SELECT name FROM _migrations WHERE name=?').get(name)){
    db.exec('BEGIN IMMEDIATE');try{db.exec(readFileSync(new URL(name,dir),'utf8'));db.raw.prepare('INSERT INTO _migrations VALUES(?)').run(name);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  }
}
export const defaultDbPath=()=>resolve(process.env.DB_PATH||new URL('../data/portal.sqlite',import.meta.url).pathname);
