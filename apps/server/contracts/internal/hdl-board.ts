import { RunnerError } from './errors.ts';
import type { BoardProfile, HdlSignal } from '../runner/hdl.ts';

export const signalWidths:Record<HdlSignal,number>={clock:1,switches:16,buttons:5,resetN:1,leds:16,anodes:8,segments:7,dp:1};
export const inputSignals=new Set<HdlSignal>(['clock','switches','buttons','resetN']);

export function fields(value:unknown,keys:string[]):asserts value is Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new RunnerError('INVALID_REQUEST','Invalid HDL fields');
}
export function identifier(value:unknown):asserts value is string {
  if(typeof value!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)||value.startsWith('xunjie_'))throw new RunnerError('INVALID_CONFIGURATION','Restricted HDL identifier required');
}
export function id(value:unknown):asserts value is string {
  if(typeof value!=='string'||!value||value.length>128||/[\x00-\x1f]/.test(value))throw new RunnerError('INVALID_REQUEST','HDL identity required');
}
export function natural(value:unknown,min=0,max=Number.MAX_SAFE_INTEGER):asserts value is number {
  if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)throw new RunnerError('INVALID_REQUEST','Invalid HDL integer');
}

export function validateBoard(value:unknown):asserts value is BoardProfile {
  fields(value,['boardProfileVersion','mappingVersion','topModule','bindings']);
  id(value.boardProfileVersion);id(value.mappingVersion);identifier(value.topModule);
  if(!Array.isArray(value.bindings)||!value.bindings.length||value.bindings.length>128)throw new RunnerError('INVALID_CONFIGURATION','Board bindings required');
  const bits=new Set<string>(),portBits=new Set<string>();
  for(const binding of value.bindings){
    fields(binding,['signal','offset','port','portOffset','width']);identifier(binding.port);
    if(typeof binding.signal!=='string'||!Object.hasOwn(signalWidths,binding.signal))throw new RunnerError('INVALID_CONFIGURATION','Unknown board signal');
    const signal=binding.signal as HdlSignal;
    natural(binding.offset);natural(binding.portOffset);natural(binding.width,1,16);
    if(binding.offset+binding.width>signalWidths[signal])throw new RunnerError('INVALID_CONFIGURATION','Board width mismatch');
    for(let j=0;j<binding.width;j++){
      const bit=signal+':'+(binding.offset+j),port=binding.port+':'+(binding.portOffset+j);
      if(bits.has(bit)||portBits.has(port))throw new RunnerError('INVALID_CONFIGURATION','Duplicate board binding');
      bits.add(bit);portBits.add(port);
    }
  }
  for(const signal of ['clock','switches','leds','anodes','segments','dp'] as const)
    for(let j=0;j<signalWidths[signal];j++)if(!bits.has(signal+':'+j))throw new RunnerError('INVALID_CONFIGURATION','Incomplete required board signal');
}
