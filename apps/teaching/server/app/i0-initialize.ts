import { z } from 'zod';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspaceDatabase,createTeachingDatabase } from '../db/transaction.ts';
import { createPasswordRecord } from '../access/password.ts';
import { helpPolicySchema,checkRuleSchema } from '../../contracts/design/index.ts';
import { storePolicy,storeRule } from '../design/activities.ts';
import { readControlledJson } from './config.ts';
import { displayTextSchema } from '../../contracts/access/index.ts';

const syntheticId = z.string().min(11).max(128).regex(/^synthetic-[A-Za-z0-9_-]+$/);
const configuration = z.strictObject({
  synthetic:z.literal(true),
  teaching:z.boolean().default(false),
  users:z.array(z.strictObject({id:syntheticId,loginName:syntheticId,password:z.string().min(16).max(1024),displayName:displayTextSchema.optional()})).min(2).max(20),
  courses:z.array(z.strictObject({id:syntheticId,name:displayTextSchema.optional(),teacherId:syntheticId,studentIds:z.array(syntheticId).min(1).max(19),
    helpPolicy:helpPolicySchema,checkRule:checkRuleSchema})).min(1).max(4),
});
export async function initializeI0(raw:unknown) {
  const input = configuration.parse(raw);
  const users = new Map(input.users.map(user=>[user.id,user]));
  if (users.size !== input.users.length || new Set(input.users.map(user=>user.loginName)).size !== users.size
    || new Set(input.courses.map(course=>course.id)).size !== input.courses.length
    || input.courses.some(course=>!users.has(course.teacherId) || course.studentIds.includes(course.teacherId)
      || new Set(course.studentIds).size !== course.studentIds.length || course.studentIds.some(id=>!users.has(id))))
    throw new Error('Invalid synthetic membership configuration.');
  const records:Awaited<ReturnType<typeof createPasswordRecord>>[] = [];
  for (const user of input.users) records.push(await createPasswordRecord(user.password));
  const db = input.teaching?createTeachingDatabase():createWorkspaceDatabase();
  try {
    db.withTransaction(tx => {
      input.users.forEach((user,index) => {
        const record=records[index]!;
        tx.run('INSERT INTO users(id,login_name,password_hash,salt,algorithm,n,r,p,key_length,display_name) VALUES (?,?,?,?,?,?,?,?,?,?)',
          user.id,user.loginName,record.hash,record.salt,'scrypt',131072,8,1,64,user.displayName??null);
      });
      for (const course of input.courses) {
        tx.run('INSERT INTO courses(id,name) VALUES (?,?)',course.id,course.name??null);
        for (const [id,role] of [[course.teacherId,'teacher'],...course.studentIds.map(id=>[id,'student'])])
          tx.run('INSERT INTO course_memberships(course_id,user_id,role,active) VALUES (?,?,?,1)',course.id,id!,role!);
        const actor={userId:course.teacherId,courseId:course.id,role:'teacher' as const};
        storePolicy(tx,actor,course.helpPolicy,Date.now());
        storeRule(tx,actor,course.checkRule,Date.now());
      }
    });
    return {db};
  } catch (error) { db.close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const file=process.env.XUNJIE_I0_INITIALIZE_CONFIG;
    if (!file) throw new Error('Controlled synthetic initialization configuration required.');
    const {db}=await initializeI0(readControlledJson(file));
    process.stdout.write(JSON.stringify({synthetic:true,databaseFile:db.file})+'\n');
    db.close();
  } catch { process.stderr.write('I0 synthetic initialization failed. No existing database was migrated.\n'); process.exitCode=1; }
}
