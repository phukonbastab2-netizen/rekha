import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
process.umask(0o077);
if(!process.env.SQLITE_PATH||!process.env.BACKUP_DIR)throw Error('private_backup_paths_required');
fs.mkdirSync(process.env.BACKUP_DIR,{recursive:true,mode:0o700});
const db=new DatabaseSync(process.env.SQLITE_PATH,{readOnly:true});
const destination=path.join(process.env.BACKUP_DIR,'funnel-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite');
await backup(db,destination);db.close();
const check=new DatabaseSync(destination,{readOnly:true});
if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('backup_integrity_failed');check.close();
// Local disk only: no R2 upload or Cloudflare database writes.
console.log(JSON.stringify({backupComplete:true,storage:'oracle-disk'}));
