import type { FastifyInstance, FastifyRequest } from 'fastify';

export type ModelSelection = {userId:string;version:string;providerId:string;baseUrl:string;model:string;apiKey:string;reasoningEffort?:'low'|'high'|'max';
  contextWindow?:number;maxOutputTokens?:number;inputTypes?:('image'|'video'|'pdf')[]};
export type CompatibleMessage = {role:'system'|'user'|'assistant';content:string};
export type CompatibleUsage = {status:'actual';inputTokens:number;outputTokens:number};
export type DiscoveredModel={id:string;name?:string;contextWindow?:number;maxOutputTokens?:number;inputTypes?:('image'|'video'|'pdf')[];reasoningLevels?:('low'|'high'|'max')[]};
export type ConnectionResult = {ok:true;latencyMs:number;modelCount:number|null;models?:DiscoveredModel[]} |
  {ok:false;kind:'auth'|'not-found'|'http'|'timeout'|'network'|'invalid-url'|'unavailable';status?:number};
export type CompatibleTransport = {
  complete(input:{selection:ModelSelection;messages:CompatibleMessage[];signal:AbortSignal;remainingMs:number;
    jsonSchema?:Record<string,unknown>;onText?:(text:string)=>void;onThinking?:()=>void;onActivity?:()=>void|Promise<void>}):Promise<{text:string;usage?:CompatibleUsage}>;
  test(input:{baseUrl:string;apiKey:string;signal:AbortSignal}):Promise<ConnectionResult>;
};
export type PersonalAgentService = {
  register(app:FastifyInstance):void;
  selection(userId:string):ModelSelection|undefined;
  configurationRevision(userId:string):number;
  close():Promise<void>;
};
export type PersonalAgentOptions = {directory:string;authorize(request:FastifyRequest):string;
  transport:CompatibleTransport;callsEnabled?:()=>boolean;now?:()=>number};
