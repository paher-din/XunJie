import type {DiscoveredModel,ModelSelection} from './types.ts';

// Independently implemented from the protocol distinctions documented in the
// I0_UI_MODEL_PROVIDER_RESEARCH_{DSH,KIMI,ZCODE} task records; no vendor framework.
type ObjectValue=Record<string,unknown>;
const record=(value:unknown):ObjectValue=>value&&typeof value==='object'&&!Array.isArray(value)?value as ObjectValue:{};
const positive=(...values:unknown[])=>values.find((v):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0);
export function discoveredModels(value:ObjectValue):{models:DiscoveredModel[];count:number}|undefined {
  const listing=Array.isArray(value.data)?value.data:value.models&&typeof value.models==='object'&&!Array.isArray(value.models)
    ?Object.entries(value.models).map(([id,metadata])=>({...record(metadata),id})):undefined;
  if(!listing)return;
  const models:DiscoveredModel[]=[];
  for(const item of listing.slice(0,100)){
    const model=record(item),id=model.id;
    if(typeof id!=='string'||!id||id.length>256)continue;
    const limit=record(model.limit),top=record(model.top_provider);
    const context=positive(model.context_window,model.contextWindow,model.context_length,model.max_input_tokens,limit.context);
    const output=positive(model.max_output_tokens,model.maxOutputTokens,model.maxTokens,model.max_tokens,limit.output,top.max_completion_tokens);
    const modalities=model.input_modalities,levels=record(model.effort).supported_levels;
    models.push({id,...(typeof model.name==='string'?{name:model.name.slice(0,128)}:{}),
      ...(context?{contextWindow:context}:{}),...(output?{maxOutputTokens:output}:{}),
      ...(Array.isArray(modalities)?{inputTypes:[...new Set(modalities.filter((t):t is 'image'|'video'|'pdf'=>t==='image'||t==='video'||t==='pdf'))]}:{}),
      ...(Array.isArray(levels)?{reasoningLevels:[...new Set(levels.filter((e):e is 'low'|'high'|'max'=>e==='low'||e==='high'||e==='max'))]}:{})});
  }
  return {models,count:listing.length};
}

/** Exact official endpoints have known dialects; other compatible services use the declared OpenAI contract. */
export function modelRequestOptions(selection:ModelSelection,maxOutput:number):ObjectValue {
  const host=new URL(selection.baseUrl).hostname,effort=selection.reasoningEffort;
  if(host==='api.kimi.com')return {max_completion_tokens:maxOutput,...(effort?{thinking:{type:'enabled',effort}}:{})};
  return {...(host==='api.openai.com'?{max_completion_tokens:maxOutput}:{max_tokens:maxOutput}),
    ...(effort?{reasoning_effort:effort}:{}),...(host==='api.deepseek.com'&&effort?{thinking:{type:'enabled'}}:{})};
}

export function hasReasoningActivity(delta:unknown):boolean {
  const value=record(delta);
  return ['reasoning_content','reasoning'].some(key=>typeof value[key]==='string'&&Boolean(value[key]))
    ||Array.isArray(value.reasoning_details)&&value.reasoning_details.some(item=>Object.keys(record(item)).length>0);
}
