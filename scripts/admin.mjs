// This command runs beside the server, with OS-level access to its database.
import {localDb,migrate,defaultDbPath} from '../server/local-db.mjs';
import {one} from '../server/db.mjs';
import {updateRequest} from '../server/api.mjs';
const [command,id]=process.argv.slice(2);const db=localDb(defaultDbPath());migrate(db);
if(command==='show'&&id)console.log(await one(db,'SELECT * FROM requests WHERE id=?',[id]));
else if(command==='status'&&id){let text='';for await(const chunk of process.stdin)text+=chunk;console.log(await updateRequest(db,id,JSON.parse(text),new Date().toISOString()));}
else console.log('node scripts/admin.mjs show REQUEST_ID\nnode scripts/admin.mjs status REQUEST_ID < status.json');
db.close();
