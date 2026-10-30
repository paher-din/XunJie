import { fields, identifier, id, natural, validateBoard, inputSignals, signalWidths } from '../contracts/internal/hdl-board.ts';
export { fields, identifier, id, natural, validateBoard, signalWidths, inputSignals } from '../contracts/internal/hdl-board.ts';
import {RunnerError,sha256,validateSnapshot} from './snapshot.ts';
import type {BoardProfile,HdlIdentity,HdlBuildRequest,HdlOperation,HdlProgram,HdlSignal} from '../contracts/runner/hdl.ts';

export const hdlLimits={buildMs:30000,stepMs:2000,lifetimeMs:1800000,idleMs:300000,maxCycles:5000000,
  frames:4096,packetBytes:65536,traceBytes:1048576,logBytes:65536,sessions:2};
export function validateIdentity(value:unknown):asserts value is HdlIdentity {
  fields(value,['id','commandId','requestHash','recoveryGeneration','scope']);
  for(const name of ['id','commandId','recoveryGeneration'])id(value[name]);
  if(typeof value.requestHash!=='string'||!/^[a-f0-9]{64}$/.test(value.requestHash))throw new RunnerError('INVALID_REQUEST','HDL request hash required');
  fields(value.scope,['courseId','studentId','attemptId','activityVersionId']);
  for(const name of ['courseId','studentId','attemptId','activityVersionId'])id(value.scope[name]);
}
export function validateBuildRequest(value:unknown):asserts value is HdlBuildRequest {
  fields(value,['identity','snapshot','board','runtimeProfileVersion']);validateIdentity(value.identity);validateSnapshot(value.snapshot);
  validateBoard(value.board);id(value.runtimeProfileVersion);
  if(!value.snapshot.files.some(file=>/\.(sv|v)$/.test(file.path)))throw new RunnerError('INVALID_REFERENCE','HDL source required');
}
export function validateProgram(value:unknown):asserts value is HdlProgram {
  fields(value,['identity','buildId','replaceSessionId','expectedSessionRevision']);validateIdentity(value.identity);id(value.buildId);
  if(value.replaceSessionId!==undefined){id(value.replaceSessionId);natural(value.expectedSessionRevision,1);}
  else if(value.expectedSessionRevision!==undefined)throw new RunnerError('INVALID_REQUEST','Replacement session required');
}
export function validateOperation(value:unknown):asserts value is HdlOperation {
  fields(value,['identity','sessionId','expectedSessionRevision','expectedSequence','inputs','advanceCycles']);validateIdentity(value.identity);id(value.sessionId);
  natural(value.expectedSessionRevision,1);natural(value.expectedSequence,1);natural(value.advanceCycles,1,hdlLimits.maxCycles);
  fields(value.inputs,['switches','buttons','resetN']);
  for(const [name,width] of [['switches',16],['buttons',5],['resetN',1]] as const)
    if(typeof value.inputs[name]!=='string'||!new RegExp(`^[01]{${width}}$`).test(String(value.inputs[name])))throw new RunnerError('INVALID_REQUEST','Binary board input required');
}
export const configurationHash=(board:BoardProfile)=>sha256(JSON.stringify(board));
export type HdlPort={name:string;direction:'input'|'output'|'inout';width:number;left:number;right:number};
export function boardWrapper(board:BoardProfile,ports:HdlPort[]):string {
  validateBoard(board);
  const names=new Set<string>();
  for(const port of ports){identifier(port.name);natural(port.width,1,128);
    if(names.has(port.name)||!['input','output','inout'].includes(port.direction)||!Number.isSafeInteger(port.left)||!Number.isSafeInteger(port.right)
      ||Math.abs(port.left-port.right)+1!==port.width)throw new RunnerError('INVALID_CONFIGURATION','Unsupported elaborated port');names.add(port.name);}
  for(const binding of board.bindings){const port=ports.find(item=>item.name===binding.port);
    if(!port||binding.portOffset+binding.width>port.width||port.direction!==(inputSignals.has(binding.signal)?'input':'output'))throw new RunnerError('INVALID_CONFIGURATION','Elaborated board port mismatch');}
  for(const port of ports.filter(item=>item.direction==='input'))
    for(let j=0;j<port.width;j++)if(!board.bindings.some(binding=>binding.port===port.name&&j>=binding.portOffset&&j<binding.portOffset+binding.width))throw new RunnerError('INVALID_CONFIGURATION','Unbound input port');
  const lines=['`timescale 1ps/1ps','module xunjie_board;'];
  for(const [signal,width] of Object.entries(signalWidths))lines.push(`${inputSignals.has(signal as HdlSignal)?'reg':'wire'} [${width-1}:0] ${signal};`);
  lines.push("initial begin clock=1'b0; switches=16'b0; buttons=5'b0; resetN=1'b1; end");
  for(const port of ports)lines.push(`wire [${port.left}:${port.right}] p_${port.name};`);
  for(const binding of board.bindings){const port=ports.find(item=>item.name===binding.port)!;
    for(let j=0;j<binding.width;j++){const p=`p_${port.name}[${port.right+(port.left>=port.right?1:-1)*(binding.portOffset+j)}]`,s=`${binding.signal}[${binding.offset+j}]`;
      lines.push(inputSignals.has(binding.signal)?`assign ${p} = ${s};`:`assign ${s} = ${p};`);}}
  lines.push(`${board.topModule} dut (${ports.map(port=>`.${port.name}(p_${port.name})`).join(',')});`,'endmodule');return lines.join('\n')+'\n';
}
