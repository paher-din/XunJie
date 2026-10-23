import { createRequire } from 'node:module';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { personalAgentSchema } from './schema.ts';
import { credentialKey } from './credentials.ts';

type Value=string|number|null|Buffer;
export type Row=Record<string,Value>;
type NativeDatabase={prepare(sql:string):{get(...parameters:Value[]):Row|undefined;all(...parameters:Value[]):Row[];run(...parameters:Value[]):{changes:number}};
  exec(sql:string):void;pragma(sql:string):unknown;close():void};
const Driver=createRequire(import.meta.url)('better-sqlite3') as new(file:string,options:{fileMustExist:boolean})=>NativeDatabase;

export function openPersonalAgentStore(directory:string) {
  if(!isAbsolute(directory))throw new Error('Absolute personal storage directory required.');
  mkdirSync(directory,{recursive:true,mode:0o700});
  const stat=lstatSync(directory);
  // Only the final component must be a real, non-symlink directory under the caller's control. Ancestor symlinks
  // (macOS /var→/private/var, symlinked home or tool directories) are the caller's own environment and stay valid.
  if(!stat.isDirectory()||stat.isSymbolicLink()
    ||(process.platform!=='win32'&&(stat.mode&0o077)!==0))throw new Error('Controlled personal storage directory required.');
  const file=join(directory,'personal-agent.sqlite'),fresh=!existsSync(file);
  if(!fresh){const existing=lstatSync(file);if(!existing.isFile()||existing.isSymbolicLink()||existing.nlink!==1
    ||(process.platform!=='win32'&&(existing.mode&0o077)!==0))throw new Error('Controlled personal database required.');}
  const key=credentialKey(join(directory,'credentials.key'),fresh);
  if(fresh)closeSync(openSync(file,'wx',0o600));
  const db=new Driver(file,{fileMustExist:true});
  try {
    db.pragma('foreign_keys=ON');db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');db.pragma('busy_timeout=1000');
    if(fresh){db.exec('BEGIN IMMEDIATE');try{db.exec(personalAgentSchema);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}}
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
    if(JSON.stringify(tables)!==JSON.stringify(['agent_conversations','agent_messages','agent_turns','user_model_configs']))
      throw new Error('Personal store requires the approved four-table scope.');
    let active=false,closed=false;
    return {file,key,
      get(sql:string,...parameters:Value[]){return db.prepare(sql).get(...parameters);},
      all(sql:string,...parameters:Value[]){return db.prepare(sql).all(...parameters);},
      run(sql:string,...parameters:Value[]){return db.prepare(sql).run(...parameters);},
      transaction<T>(work:()=>T):T {
        if(active||closed)throw new Error('Invalid personal transaction.');
        db.exec('BEGIN IMMEDIATE');active=true;
        try{const value=work();if(value&&typeof value==='object'&&'then' in value)throw new Error('Synchronous personal transaction required.');db.exec('COMMIT');return value;}
        catch(error){db.exec('ROLLBACK');throw error;}finally{active=false;}
      },
      close(){if(!closed){closed=true;key.fill(0);db.close();}},
    };
  } catch(error){db.close();key.fill(0);throw error;}
}
export type PersonalAgentStore=ReturnType<typeof openPersonalAgentStore>;
