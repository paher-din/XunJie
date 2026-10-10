export type StdoutRecords =
  | {kind:'stats';records:{path:string;values:number[]}[];total:number[]}
  | {kind:'top';records:{word:string;count:number}[]}
  | {kind:'find';records:{path:string;line:number;text:string}[]};

export function matchesStdout(text: string, expectation: StdoutRecords): boolean {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (expectation.kind === 'top') {
    if (lines.length !== expectation.records.length) return false;
    return lines.every((line,index) => {
      const values = line.trim().match(/^([a-z0-9]+)\s+(\d+)$/);
      return values?.[1]===expectation.records[index].word && Number(values[2])===expectation.records[index].count;
    });
  }
  if (expectation.kind === 'find') {
    if (lines.length !== expectation.records.length) return false;
    const remaining=[...expectation.records];
    for(const line of lines) {
      const index=remaining.findIndex(record => [record.path,`/snapshot/${record.path}`].some(path =>
        line===`${path}:${record.line}:${record.text}` || line===`${path}\t${record.line}\t${record.text}`));
      if(index<0)return false;
      remaining.splice(index,1);
    }
    return remaining.length===0;
  }
  if(lines.length!==expectation.records.length+1)return false;
  const total=lines.pop()!.split('\t');
  if(total[0]!=='TOTAL' || total.length!==4 || !total.slice(1).every((value,index)=>/^\d+$/.test(value)&&Number(value)===expectation.total[index]))return false;
  const remaining=[...expectation.records];
  for(const line of lines) {
    const values=line.split('\t');
    if(values.length!==4)return false;
    const index=remaining.findIndex(record=>values[0]===record.path||values[0]===`/snapshot/${record.path}`);
    if(index<0 || !values.slice(1).every((value,i)=>/^\d+$/.test(value)&&Number(value)===remaining[index].values[i]))return false;
    remaining.splice(index,1);
  }
  return remaining.length===0;
}
