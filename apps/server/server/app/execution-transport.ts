import {sshRunner} from '../records/runner.ts';
import type {HdlTransport} from '../workspace/hdl.ts';
export function executionTransports(settings:Parameters<typeof sshRunner>[0]){
 const runner=sshRunner(settings);
 // C's fixed xunjie-c1 wire handler accepts both original command families.
 // SSH options and executable are still exclusively controlled by sshRunner.
 const hdlTransport: HdlTransport=command=>runner(command as unknown as Parameters<typeof runner>[0]);
 return {runner,hdlTransport};
}
