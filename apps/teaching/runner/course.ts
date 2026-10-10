import { expectedReport, wordFrequency } from './report.ts';
import { textScopeArgs } from './run-snapshot.ts';
import type { TextScopeInput } from './run-snapshot.ts';
import type { Snapshot } from './snapshot.ts';
import type { TrustedCase } from './verify.ts';
import { RunnerError } from './snapshot.ts';

export function courseChecks(snapshot: Snapshot, input: TextScopeInput, version: string): {args: string[]; rule: TrustedCase}[] {
  if (!['textscope-core-v1', 'textscope-report-v1'].includes(version)
    || (version === 'textscope-report-v1') !== (input.operation === 'report')) {
    throw new RunnerError('INVALID_CONFIGURATION', 'Course check version does not match operation');
  }
  const args = textScopeArgs(snapshot, input, input.operation === 'report' ? ['report.txt'] : []);
  const inputs = input.fileIds.map(id => snapshot.files.find(file => file.fileId === id)!);
  const expected = expectedReport(inputs.map(file => ({path:file.path, text:file.text})));
  const base = { checkRuleVersion: version, validatorVersion: 'textscope-validator-v1', expectedExitCode: 0 };
  let rule: TrustedCase;
  if (input.operation === 'report') rule = { ...base, expectedReport: { relativeName: 'report.txt', expectation: expected } };
  else if (input.operation === 'stats') rule = { ...base, stdoutRecords: {
    kind:'stats', records:expected.files.map(file => ({path:file.path, values:[file.lines,file.words,file.bytes]})), total:expected.total } };
  else if (input.operation === 'top') rule = { ...base, stdoutRecords: {
    kind:'top', records: wordFrequency(inputs.map(file=>file.text)).slice(0, Number(input.count))
      .map(item => ({word:item.word,count:item.count})) } };
  else {
    const matches = inputs.flatMap(file => file.text.split('\n').flatMap((text, index) =>
      (text.match(/[A-Za-z0-9]+/g) ?? []).some(word => word.toLowerCase() === input.word!.toLowerCase())
        ? [{path:file.path,line:index+1,text}] : []));
    rule = { ...base, stdoutRecords:{kind:'find',records:matches} };
  }
  const error = (code: number): TrustedCase => ({...base, expectedExitCode:code, requireDiagnostic:code===1?'stderr':'either'});
  let missing='__xunjie_missing_input__';
  for(let suffix=1;snapshot.files.some(file=>file.path===missing||file.path.startsWith(missing+'/'));suffix++) {
    missing=`__xunjie_missing_input__.${suffix}`;
  }
  return [{args,rule},
    {args:['__invalid_command__'],rule:error(2)},
    {args:['stats'],rule:error(2)},
    {args:['top','-n','0',...args.filter(arg=>arg.startsWith('/snapshot/'))],rule:error(2)},
    {args:['stats',`/snapshot/${missing}`],rule:error(1)}];
}
