import { z } from 'zod';
import { openSyntheticDatabase } from '../../server/db/transaction.ts';
import { createVerificationApp } from '../../server/access/app.ts';

process.once('message', async (input: unknown) => {
  let close: (() => Promise<void>) | undefined;
  try {
    const command = z.strictObject({ file: z.string(), origin: z.string(), signingSecret: z.string(),
      cookie: z.string(), loginName: z.string(), password: z.string() }).parse(input);
    const db = openSyntheticDatabase(command.file);
    const verification = await createVerificationApp({ db, origin: command.origin, signingSecret: command.signingSecret });
    close = async () => { await verification.app.close(); db.close(); };
    verification.app.get('/fixture/course', request => verification.access.authorizeCourse(request, 'course'));
    const identity = await verification.app.inject({ url: '/fixture/course', headers: { cookie: command.cookie } });
    const limited = await verification.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin: command.origin }, payload: { loginName: command.loginName, password: command.password } });
    process.send?.({ identityStatus: identity.statusCode, loginStatus: limited.statusCode });
  } catch { process.send?.({ failed: true }); process.exitCode = 1; }
  finally { await close?.(); process.disconnect?.(); }
});
