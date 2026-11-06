import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { componentRuntimeManifestSchema } from '@xunjie/contracts/components';
import { courseExecutionPlanBasis } from '@xunjie/contracts/execution';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const id = n => `19200000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export async function aluPackage() {
  const runtime = JSON.parse(await readFile(new URL('../alu-icarus-runtime/manifest.json', import.meta.url),'utf8'));
  const view = Buffer.from((await readFile(new URL('view.html',import.meta.url),'utf8')).replaceAll('\r\n','\n'));
  const resources = [], runtimeResources = [];
  for (const [index, name] of [...Object.keys(runtime.files).filter(name=>!Object.hasOwn(runtime.adapters,name)), 'single.sv', 'self-check.sv'].entries()) {
    const local = ['single.sv','self-check.sv'].includes(name);
    const source = await readFile(new URL(local ? name : `../alu-icarus-runtime/${name}`, import.meta.url));
    const bytes = local ? Buffer.from(source.toString('utf8').replaceAll('\r\n','\n')) : source;
    const ref = { resourceId:id(20+index),path:name,sha256:hash(bytes),byteLength:bytes.length,
      role:name.endsWith('.wasm')?'toolchain-wasm':name.endsWith('.js')?'toolchain-script':local?'scaffold':'attachment',
      mediaType:name.endsWith('.wasm')?'application/wasm':name.endsWith('.js')?'text/javascript':name.endsWith('.gz')?'application/gzip':name.endsWith('.json')?'application/json':'text/plain' };
    resources.push(ref); runtimeResources.push({resourceId:ref.resourceId,contentBase64:bytes.toString('base64')});
  }
  const controls = {type:'object',properties:Object.fromEntries(['A','B','M','S','Cin'].map(k=>[k,{type:'number'}]))};
  const manifest=componentRuntimeManifestSchema.parse({formatVersion:3,componentId:id(1),version:1,hostApiVersion:1,
    preparationProtocolVersion:2,title:'ALU 实验',entry:{resourceId:id(2),sha256:hash(view),byteLength:view.length,mediaType:'text/html'},
    stateVersion:1,stateShape:controls,initialState:{A:0,B:0,M:0,S:0,Cin:0},requiredCapabilities:['workspace.read','workspace.change','execution.submit'],
    runtime:{adapterId:'icarus-alu',adapterVersion:1,bundleIdentity:runtime.identity,resources,operations:[{operationId:'run-single',effect:'execute',
      parameters:controls,compile:{top:'experiment',entryFiles:['alu.sv'],includeDirs:[]},
      observation:{scaffoldResourceId:resources.find(r=>r.path==='single.sv').resourceId,scaffoldVersion:1,ports:{result:'F',carry:'Cout'},resultFormat:'xunjie-observations-v1'},
      result:{type:'object',properties:{f:{type:'string',maxLength:4},cout:{type:'string',maxLength:1},observationState:{type:'string',maxLength:40}}},
      budgets:{compileTimeoutMs:30000,simulateTimeoutMs:5000,jobTimeoutMs:40000,memoryMiB:256,inputBytes:1048576,textBytes:2097152,vcdBytes:8388608,resultBytes:16777216}}]},
    environment:{preparationType:'browser',preparationProtocolVersion:2,selfTestVersion:1,requiredFeatures:['worker','webassembly','crypto-subtle','indexeddb','message-port','web-locks']},
    budget:{resourceCount:32,totalResourceBytes:16777216,preparationTimeoutMs:300000,selfTestTimeoutMs:60000,concurrentJobs:1,queuedJobs:1,cacheScope:'device-local'},
    selfTest:{selfTestVersion:1,fixture:{resourceId:resources.find(r=>r.path==='self-check.sv').resourceId,path:'self-check.sv',top:'self_check',expect:{result:'0101',carry:'0'}},timeoutMs:60000}});
  return {requestId:id(3),manifest,contentBase64:view.toString('base64'),runtimeResources};
}
export async function aluCoursePackage() {
  const component=await aluPackage(), definition={manifest:component.manifest,digest:hash(JSON.stringify(component.manifest))};
  const materials=[]; const resources=[];
  for(const [index,name] of ['learning.md','alu.sv'].entries()) {
    const bytes=Buffer.from((await readFile(new URL(name,import.meta.url),'utf8')).replaceAll('\r\n','\n'));
    materials.push({materialId:id(60+index),title:name,path:name,mediaType:'text/plain',access:'student',sha256:hash(bytes),byteLength:bytes.length});
    resources.push({path:name,contentBase64:bytes.toString('base64')});
  }
  const executionPlan={planId:'alu-browser',planVersion:1,planDigest:'0'.repeat(64),components:[{key:'alu',definitionDigest:definition.digest,configurationDigest:hash(JSON.stringify({title:'ALU 实验'})),operations:['run-single']}],
    capabilities:['workspace.read','workspace.change','execution.submit'],resources:{browser:{features:['worker','webassembly','sandboxed-frame']},native:null},locations:['browser'],remote:null};
  executionPlan.planDigest=hash(JSON.stringify(courseExecutionPlanBasis(executionPlan)));
  return {formatVersion:1,requestId:id(70),course:{courseId:id(71),name:'数字逻辑与部件设计'},task:{taskId:id(72),title:'设计并验证 4 位 ALU',summary:'公开五种操作，编辑 SystemVerilog 并进行单次真实实验。'},
    release:{releaseId:id(73),objectives:['理解运算选择、固定位宽与进位','使用真实观察检验自己的实现'],requirements:'编辑 alu.sv，实现公开的五种组合 ALU 操作，并用单次输入观察真实 F/Cout。允许内置加法，保留组合归零。完整行为表位于 ALU 实验的「公开行为与采样规则」，按需补学资料位于学习索引。Agent 只解释，不修改学生代码。',materials,
      starterWorks:[{workId:id(74),title:'alu.sv',description:'仅含端口与 TODO 的学生骨架',materialId:id(61)}],capabilities:[{kind:'component',objectId:component.manifest.componentId,version:1}],
      components:[{key:'alu',definition,configuration:{title:'ALU 实验'},materialIds:[]}],executionPlan},resources};
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
