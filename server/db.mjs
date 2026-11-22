export const stmt = (db, sql, args = []) => db.prepare(sql).bind(...args);
export const all = async (db, sql, args = []) => (await stmt(db, sql, args).all()).results;
export const one = (db, sql, args = []) => stmt(db, sql, args).first();
export const run = (db, sql, args = []) => stmt(db, sql, args).run();
export const json = x => typeof x === 'string' ? JSON.parse(x) : x;
export const dataRows = rows => rows.map(x => ({...json(x.data), ...Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'data'))}));
