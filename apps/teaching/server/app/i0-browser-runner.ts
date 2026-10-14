/** Private synthetic transport for the actual browser host; no compiler, VM or HTTP control route. */
import { createHash } from 'node:crypto';
import { canonical } from '../records/commands.ts';
import type { RunnerTransport } from '../records/runner.ts';
import type { RunFact, RunIdentity, SubmitRun } from '../../contracts/runner/index.ts';
import { syntheticProfile } from '../workspace/test-support.ts';
import { textScopeArgs } from '../../runner/run-snapshot.ts';
import { validateSnapshot } from '../../runner/snapshot.ts';

export const browserRunnerOutcomes = ['running','success','compile-error','program-error','timeout','output-limit',
  'infrastructure-error','unknown','report-complete','report-missing','report-incomplete'] as const;
export type BrowserRunnerOutcome = typeof browserRunnerOutcomes[number];
export type BrowserRunnerFinishedOutcome = Exclude<BrowserRunnerOutcome,'running'|'unknown'>;
export interface BrowserRunnerConfiguration {
  ready?: boolean; outcome?: BrowserRunnerOutcome; stopConfirmed?: boolean; link?: 'online'|'offline';
}
const digest = (text: string) => createHash('sha256').update(text,'utf8').digest('hex');
type Counts = {submit:number;query:number;cancel:number;readResult:number;submitEffects:number};
const emptyCounts = (): Counts => ({submit:0,query:0,cancel:0,readResult:0,submitEffects:0});
type Entry = {identity:RunIdentity;submission?:SubmitRun;fact:RunFact;record?:Record<string,unknown>};

export function createBrowserRunner(generation:()=>string) {
  const entries = new Map<string,Entry>(), counts = new Map<string,Counts>();
  const totals=emptyCounts(); let readiness=0;
  let configuration = {ready:true,outcome:'success' as BrowserRunnerOutcome,stopConfirmed:true,link:'online' as 'online'|'offline'};
  function original(identity:RunIdentity):Entry|undefined {
    if(!identity.runId || identity.recoveryGeneration!==generation()) throw new Error('Synthetic original generation required');
    const entry=entries.get(identity.runId);
    if(entry&&canonical(entry.identity)!==canonical(identity)) throw new Error('Synthetic original identity mismatch');
    return entry;
  }
  function finished(entry:Entry,outcome:BrowserRunnerFinishedOutcome) {
    if(!entry.submission || entry.fact.stopRequested || entry.record || !['running','outcome_unknown'].includes(entry.fact.state))
      throw new Error('Synthetic original result unavailable');
    if(outcome==='infrastructure-error') {
      entry.fact={...entry.fact,state:'failed',reserved:false,units:[],pending:[]};return;
    }
    const identity=entry.identity,check=entry.submission.mode==='check';
    const failureKind = ({'compile-error':'compile_error','program-error':'program_error',timeout:'timeout',
      'output-limit':'output_limit'} as Partial<Record<BrowserRunnerFinishedOutcome,string>>)[outcome];
    const stdout=check?'PRIVATE_SYNTHETIC_CHECK_OUTPUT':failureKind?'':`隔离合成运行结果：${entry.submission.input.operation}\n`;
    const record:Record<string,unknown>={runId:identity.runId,snapshotId:identity.snapshotId,snapshotHash:identity.snapshotHash,
      inputHash:identity.inputHash,runtimeProfileVersion:identity.runtimeProfileVersion,imageDigest:identity.imageDigest,
      unitTerminated:true,phases:[{phase:failureKind==='compile_error'?'compile':'execute',containerId:'synthetic-unit',
        exitCode:failureKind?1:0,stdout,stderr:failureKind?'隔离合成运行诊断\n':'',outputBytes:Buffer.byteLength(stdout+(failureKind?'隔离合成运行诊断\n':'')),
        durationMs:1,unitTerminated:true}],...(failureKind?{failureKind}:{}),
      ...(check?{verdict:'failed',checkResults:[{expected:'PRIVATE_SYNTHETIC_CHECK_ANSWER'}]}:{})};
    if(outcome.startsWith('report-')) {
      if(entry.submission.input.operation!=='report') throw new Error('Synthetic approved report input required');
      const text='\uFEFF隔离合成报告\r\nstudent-owned report 😀\n<script>alert("synthetic")</script>\r',status=outcome==='report-complete'?'complete':outcome==='report-missing'?'missing':'incomplete';
      const contentHash=status==='missing'?undefined:digest(text);
      record.resultFiles=[{relativeName:'report.txt',status,runId:identity.runId,snapshotId:identity.snapshotId,
        source:'runner_result_file',caseIndex:0,resultFileId:digest(JSON.stringify([identity.runId,identity.snapshotId,0,'report.txt',contentHash])),
        ...(status==='missing'?{}:{text,contentHash,bytes:Buffer.byteLength(text,'utf8')})}];
    }
    entry.record=structuredClone(record);
    entry.fact={...entry.fact,state:'succeeded',reserved:false,units:[],pending:[],
      resultRef:`synthetic-result-${identity.runId}`,resultHash:digest(JSON.stringify(record))};
  }
  const transport:RunnerTransport=async command=> {
    if(command.op==='readiness') {
      readiness++;
      if(configuration.link==='offline') throw new Error('Synthetic runner link unavailable');
      const fingerprint={profile:syntheticProfile,sourceHash:'d'.repeat(64)};
      return {data:{ready:configuration.ready,...syntheticProfile,recoveryGeneration:generation(),fingerprint,
        validation:{passed:true,fingerprintHash:digest(JSON.stringify(fingerprint)),validatedAt:new Date().toISOString()}}};
    }
    const identity=command.op==='submit'?command.submission.identity:command.identity;
    const counted=counts.get(identity.runId)??emptyCounts();counts.set(identity.runId,counted);
    counted[command.op]++;totals[command.op]++;
    if(configuration.link==='offline') throw new Error('Synthetic runner link unavailable');
    let entry=original(identity);
    if(command.op==='submit') {
      validateSnapshot(command.submission.snapshot);
      if(identity.snapshotId!==command.submission.snapshot.snapshotId||identity.snapshotHash!==command.submission.snapshot.hash
        ||identity.runtimeProfileVersion!==syntheticProfile.runtimeProfileVersion||identity.imageDigest!==syntheticProfile.imageDigest
        ||identity.inputHash!==digest(JSON.stringify(textScopeArgs(command.submission.snapshot,command.submission.input,syntheticProfile.approvedResultFiles))))
        throw new Error('Synthetic original submission mismatch');
      if(entry?.submission && canonical(entry.submission)!==canonical(command.submission)) throw new Error('Synthetic original submission changed');
      // A previously accepted cancellation is retained even if a late submit appears.
      if(!entry) {
        entry={identity:structuredClone(identity),submission:structuredClone(command.submission),
          fact:{identity:structuredClone(identity),state:'running',reserved:true,stopRequested:false,units:['synthetic-unit'],pending:[]}};
        entries.set(identity.runId,entry);counted.submitEffects++;totals.submitEffects++;
        const outcome=configuration.outcome;
        if(outcome==='unknown') {entry.fact={...entry.fact,state:'outcome_unknown'};throw new Error('Synthetic submit ACK lost after acceptance');}
        if(outcome!=='running')finished(entry,outcome);
      }
    } else if(command.op==='cancel') {
      if(!entry) {entry={identity:structuredClone(identity),fact:{identity:structuredClone(identity),state:'cancelled',reserved:false,
        stopRequested:true,units:[],pending:[]}};entries.set(identity.runId,entry);}
      else if(entry.record || ['cancelled','failed'].includes(entry.fact.state)) entry.fact={...entry.fact,stopRequested:true};
      else entry.fact={...entry.fact,stopRequested:true,state:configuration.stopConfirmed?'cancelled':'cancelling',
        reserved:!configuration.stopConfirmed,units:configuration.stopConfirmed?[]:['synthetic-unit'],pending:configuration.stopConfirmed?[]:['synthetic-pending-create']};
    }
    if(command.op==='readResult') {
      if(!entry?.record) throw new Error('Synthetic original result unavailable');
      return {data:structuredClone(entry.record)};
    }
    return {data:entry?structuredClone(entry.fact):null};
  };
  return {
    transport,
    configure(change:BrowserRunnerConfiguration) {configuration={...configuration,...change};return {...configuration};},
    finish(runId:string,outcome:BrowserRunnerFinishedOutcome='success') {
      const entry=entries.get(runId);if(!entry) throw new Error('Synthetic original run unavailable');
      finished(entry,outcome);return {runId,state:entry.fact.state};
    },
    confirmStop(runId:string) {
      const entry=entries.get(runId);
      if(!entry?.fact.stopRequested || entry.record || !['cancelling','outcome_unknown','cancelled'].includes(entry.fact.state))
        throw new Error('Synthetic original stop intent required');
      entry.fact={...entry.fact,state:'cancelled',reserved:false,units:[],pending:[]};return {runId,state:entry.fact.state};
    },
    inspect(runId?:string) {
      const selected=runId?[[runId,entries.get(runId)] as const]:[...entries.entries()];
      return {readiness,totals:{...totals},configuration:{...configuration},runs:selected.map(([id,entry])=>({runId:id,
        counts:{...(counts.get(id)??emptyCounts())},fact:entry?structuredClone(entry.fact):null}))};
    },
  };
}
