import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { componentRuntimeManifestSchema } from '@xunjie/contracts/components';
import { courseExecutionPlanBasis, canonicalValue } from '@xunjie/contracts/execution';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const id = n => `19200000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const runBudgets={compileTimeoutMs:30000,simulateTimeoutMs:5000,jobTimeoutMs:40000,memoryMiB:256,inputBytes:1048576,
  textBytes:2097152,vcdBytes:8388608,resultBytes:16777216};
const controls = {type:'object',properties:Object.fromEntries(['A','B','M','S','Cin'].map(k=>[k,{type:'number'}]))};
/**
 * Version 3 adds editable case/reflection drafts and immutable-owner selections. Predictions are
 * fixed in the original command's state basis; observations remain in the execution owner.
 */
const stateShape = {type:'object',properties:{
  A:{type:'number'},B:{type:'number'},M:{type:'number'},S:{type:'number'},Cin:{type:'number'},
  inputRevision:{type:'number'},activationRevision:{type:'number'},
  enabledBasis:{type:'string',maxLength:4000},pendingActivation:{type:'string',maxLength:64},
  pendingActivationRevision:{type:'number'},pendingActivationBase:{type:'number'},
  selectedObservation:{type:'string',maxLength:64},selectedObservationRevision:{type:'number'},
  selectedCheck:{type:'string',maxLength:64},selectedCheckBasis:{type:'string',maxLength:64},
  feedbackPolicy:{type:'string',maxLength:8},
  caseDraft:{type:'string',maxLength:16000},caseRequestId:{type:'string',maxLength:64},
  selectedCase:{type:'string',maxLength:64},reflectionFor:{type:'string',maxLength:64},
  reflectionParent:{type:'string',maxLength:64},
  reflectionDraft:{type:'string',maxLength:8000},waveSelection:{type:'string',maxLength:4000},
}};
const initialState={A:0,B:0,M:0,S:0,Cin:0,inputRevision:0,activationRevision:0,enabledBasis:'',pendingActivation:'',
  pendingActivationRevision:0,pendingActivationBase:0,
  selectedObservation:'',selectedObservationRevision:-1,selectedCheck:'',selectedCheckBasis:'',feedbackPolicy:'live',
  caseDraft:'',caseRequestId:'',selectedCase:'',reflectionFor:'',reflectionParent:'',reflectionDraft:'',waveSelection:''};
const runResult={type:'object',properties:{f:{type:'string',maxLength:4},cout:{type:'string',maxLength:1},
  observationState:{type:'string',maxLength:40},operationId:{type:'string',maxLength:20},dependencyId:{type:'string',maxLength:64}}};
const checkResult={type:'object',properties:{verdict:{type:'string',maxLength:12},totalInputs:{type:'number'},
  plannedSamples:{type:'number'},sampledRows:{type:'number'},comparedRows:{type:'number'},
  behaviorErrorInputs:{type:'number'},unknownInputs:{type:'number'},inconsistentInputs:{type:'number'},
  missingInputs:{type:'number'},roundsCompleted:{type:'number'}}};
const operation = (operationId,scaffoldPath,parameters,result) => ({operationId,effect:'execute',parameters,
  compile:{top:'experiment',entryFiles:['alu.sv'],includeDirs:[]},
  observation:{scaffoldResourceId:null,scaffoldVersion:1,ports:{result:'F',carry:'Cout'},resultFormat:'xunjie-observations-v1'},
  result,budgets:{...runBudgets},_scaffoldPath:scaffoldPath});
const operations = [
  operation('run-single','single.sv',controls,runResult),
  operation('observe-enabled','single.sv',controls,runResult),
  operation('check-all','check.sv',{type:'object',properties:{}},checkResult),
];
export async function aluPackage() {
  const runtime = JSON.parse(await readFile(new URL('../alu-icarus-runtime/manifest.json', import.meta.url),'utf8'));
  const view = Buffer.from((await readFile(new URL('view.html',import.meta.url),'utf8')).replaceAll('\r\n','\n'));
  const localScaffolds=['single.sv','self-check.sv','check.sv'];
  const resources = [], runtimeResources = [];
  for (const [index, name] of [...Object.keys(runtime.files).filter(name=>!Object.hasOwn(runtime.adapters,name)), ...localScaffolds].entries()) {
    const local = localScaffolds.includes(name);
    const source = await readFile(new URL(local ? name : `../alu-icarus-runtime/${name}`, import.meta.url));
    const bytes = local ? Buffer.from(source.toString('utf8').replaceAll('\r\n','\n')) : source;
    const ref = { resourceId:id(20+index),path:name,sha256:hash(bytes),byteLength:bytes.length,
      role:name.endsWith('.wasm')?'toolchain-wasm':name.endsWith('.js')?'toolchain-script':local?'scaffold':'attachment',
      mediaType:name.endsWith('.wasm')?'application/wasm':name.endsWith('.js')?'text/javascript':name.endsWith('.gz')?'application/gzip':name.endsWith('.json')?'application/json':'text/plain' };
    resources.push(ref); runtimeResources.push({resourceId:ref.resourceId,contentBase64:bytes.toString('base64')});
  }
  const scaffold = path => resources.find(resource => resource.path===path).resourceId;
  for (const item of operations) item.observation.scaffoldResourceId = scaffold(item._scaffoldPath);
  const manifest=componentRuntimeManifestSchema.parse({formatVersion:3,componentId:id(1),version:3,hostApiVersion:1,
    preparationProtocolVersion:2,title:'ALU 实验',entry:{resourceId:id(2),sha256:hash(view),byteLength:view.length,mediaType:'text/html'},
    stateVersion:3,stateShape,initialState,requiredCapabilities:['workspace.read','workspace.change','execution.submit'],
    runtime:{adapterId:'icarus-alu',adapterVersion:1,bundleIdentity:runtime.identity,resources,
      operations:operations.map(({_scaffoldPath,...item})=>item)},
    environment:{preparationType:'browser',preparationProtocolVersion:2,selfTestVersion:1,requiredFeatures:['worker','webassembly','crypto-subtle','indexeddb','message-port','web-locks']},
    budget:{resourceCount:32,totalResourceBytes:16777216,preparationTimeoutMs:300000,selfTestTimeoutMs:60000,concurrentJobs:1,queuedJobs:1,cacheScope:'device-local'},
    selfTest:{selfTestVersion:1,fixture:{resourceId:resources.find(r=>r.path==='self-check.sv').resourceId,path:'self-check.sv',top:'self_check',expect:{result:'0101',carry:'0'}},timeoutMs:60000}});
  return {requestId:id(104),manifest,contentBase64:view.toString('base64'),runtimeResources};
}
export async function aluCoursePackage() {
  const component=await aluPackage(), definition={manifest:component.manifest,digest:hash(JSON.stringify(component.manifest))};
  const materials=[]; const resources=[];
  for(const [index,name] of ['learning.md','alu.sv'].entries()) {
    const bytes=Buffer.from((await readFile(new URL(name,import.meta.url),'utf8')).replaceAll('\r\n','\n'));
    materials.push({materialId:id(60+index),title:name,path:name,mediaType:'text/plain',access:'student',sha256:hash(bytes),byteLength:bytes.length});
    resources.push({path:name,contentBase64:bytes.toString('base64')});
  }
  const configuration={title:'ALU 实验',boardMapping:{version:1,inputs:{A:[3,2,1,0],B:[7,6,5,4],M:[8],S:[10,9],Cin:[11]},outputs:{F:[3,2,1,0],Cout:[4]}}};
  const executionPlan={planId:'alu-browser',planVersion:3,planDigest:'0'.repeat(64),components:[{key:'alu',definitionDigest:definition.digest,
    configurationDigest:hash(JSON.stringify(canonicalValue(configuration))),operations:['run-single','observe-enabled','check-all']}],
    capabilities:['workspace.read','workspace.change','execution.submit'],resources:{browser:{features:['worker','webassembly','sandboxed-frame']},native:null},
    locations:['browser'],remote:null};
  executionPlan.planDigest=hash(JSON.stringify(courseExecutionPlanBasis(executionPlan)));
  return {formatVersion:1,requestId:id(175),course:{courseId:id(71),name:'数字逻辑与部件设计'},task:{taskId:id(72),title:'设计并验证 4 位 ALU',
    summary:'公开五种操作，编辑 SystemVerilog，用虚拟板自由观察并运行完整的 4096 组真实行为检查。'},
    release:{releaseId:id(176),objectives:['理解运算选择、固定位宽与进位','使用真实观察检验自己的实现','用完整输入域发现遗漏赋值和未知输出','用一条边界用例和一条操作区别用例说明自己的选择与观察'],
      requirements:'编辑 alu.sv，实现公开的五种组合 ALU 操作。点击运行启用当时的作品；之后在虚拟板上改变 A/B/M/S/Cin 观察真实 F/Cout，或对已启用作品运行全部 4096 组输入检查。允许内置加法，保留组合必须归零。完整行为表、映射、采样与检查说明位于 ALU 实验的「公开行为与采样规则」，按需补学资料位于学习索引。Agent 只解释，不修改学生代码。',
      materials,starterWorks:[{workId:id(74),title:'alu.sv',description:'仅含端口与 TODO 的学生骨架',materialId:id(61)}],
      capabilities:[{kind:'component',objectId:component.manifest.componentId,version:3}],
      components:[{key:'alu',definition,configuration,materialIds:[]}],executionPlan},resources};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const out=resolve(process.argv[2]??'dist/alu-experiment'); await mkdir(out,{recursive:true});
  const component=await aluPackage(), course=await aluCoursePackage();
  await writeFile(resolve(out,'view.html'),Buffer.from(component.contentBase64,'base64'));
  for(const ref of component.manifest.runtime.resources) {
    const uploaded=component.runtimeResources.find(item=>item.resourceId===ref.resourceId);
    const path=resolve(out,'runtime',ref.path);await mkdir(dirname(path),{recursive:true});
    await writeFile(path,Buffer.from(uploaded.contentBase64,'base64'));
  }
  for(const resource of course.resources)await writeFile(resolve(out,resource.path),Buffer.from(resource.contentBase64,'base64'));
  await writeFile(resolve(out,'component.json'),JSON.stringify({requestId:component.requestId,manifest:component.manifest,path:'view.html',
    runtimeFiles:component.manifest.runtime.resources.map(ref=>({resourceId:ref.resourceId,path:`runtime/${ref.path}`}))},null,2));
  const {resources:_embedded,...courseManifest}=course;
  await writeFile(resolve(out,'course.json'),JSON.stringify(courseManifest,null,2));
  console.log(JSON.stringify({out,runtimeIdentity:component.manifest.runtime.bundleIdentity,resources:component.runtimeResources.length}));
}
