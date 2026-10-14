import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const localRoot='D:\\XunJie_Project\\i0-ui55-connection\\hdl-ui\\local-environment';
const retainedRoot='D:\\XunJie_Project\\i0-ui55-connection';
const tlsCertificate=retainedRoot+'\\local-relay\\gateway-server.crt.pem';
const tlsKey=retainedRoot+'\\local-relay\\gateway-server.key.pem';
const certificateSha256='8d663b4dba93b1fb61df544fe3fe17022e561d88a559576381abf1220b3ac52e';
const gib=1024**3;

/** A reviewable deployment plan, not an installer or an authorization substitute. */
export function localEnvironmentPlan() {
  return {
    version:1,purpose:'Robert-local synthetic HDL browser acceptance; no PAHER dependency',
    mutationsPerformed:false,credentialsRead:false,networkRequestsPerformed:false,
    windowsRetainedRoot:localRoot,
    host:{distribution:'Ubuntu',basePath:'D:\\SystemMigrations\\wsl\\Ubuntu',prefix:'/opt/xunjie-runner',
      role:'Business HTTPS/SQLite/model outside the dedicated execution guest; portable runtimes under this fresh prefix',
      keepAlive:'Owned bounded hidden foreground WSL process while this environment is running; no global WSL settings or automatic startup changes'},
    guest:{name:'xunjie-c1-robert',architecture:'amd64',virtualization:'QEMU q35/KVM in the existing WSL2 Ubuntu',
      vcpus:2,memoryMiB:4096,virtualDiskGiB:20,guestDisk:'/opt/xunjie-runner/vm/state/guest.qcow2',
      seed:'/opt/xunjie-runner/vm/state/seed.iso',sshEndpoint:'127.0.0.1:2222',
      sharedFolders:false,exposesDockerSocket:false,studentContainersNetwork:'none',
      stopIfKvmUnavailable:true,noImplicitTcgFallback:true},
    executionSource:{gitCommit:'9fa76adbfb37a60cc087f8bf2fbdd1e05cd18e77',
      equivalentRunnerCommit:'26e5b840270cbf489cb21e23d1d4ee2f3ad30998',
      archivePaths:['apps/teaching/runner','apps/teaching/contracts/runner'],fingerprintedRunnerFiles:32,
      fingerprintedContracts:['index.ts','hdl.ts'],
      sourceHash:'7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852',
      verified:'2026-10-14: original nodeFingerprint algorithm recomputed from Git bytes for both commits; exact same hash',
      deployCurrentMainH3:false,businessAndUi:'Current reviewed main APIs plus this task owned HDL UI; guest remains the original frozen runner'},
    frozenImages:[
      {role:'C compiler',image:'sha256:9f14e671a09bc195b93ca39524b8dcf401bc832b0c520e462327ce94986799aa',source:'Official GCC OCI manifest listed below'},
      {role:'C runtime',image:'sha256:765d51df494104de704bbecfdfdd42945077ea4c8f11fb49f91e9dca27a6fe99',source:'2026-10-14 live restricted readiness and verified original non-secret OCI archive; supersedes the earlier historical e658 candidate'},
      {role:'HDL build',image:'sha256:6a0e6ee8ab6bffc7a4fc999c5dbdcf68f058ed04cb13f053730e7209e3efad0d',source:'Original non-secret derived OCI archive; not asserted to be publicly pullable'},
      {role:'HDL runtime',image:'sha256:6a3c202ccc35152020f156ad4d9665f08cb45ff9893fe5c51b6be9e788243ca5',source:'Original non-secret derived OCI archive; not asserted to be publicly pullable'},
    ],
    publicDownloads:[
      {name:'Ubuntu Noble fixed base',url:'https://cloud-images.ubuntu.com/noble/20260926/noble-server-cloudimg-amd64.img',
        bytes:625612288,sha256:'6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2',
        authority:'https://cloud-images.ubuntu.com/noble/20260926/SHA256SUMS',verified:'2026-10-14: HEAD200 and exact official checksum'},
      {name:'Portable Linux Node',version:'24.21.0',url:'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz',
        bytes:31890184,sha256:'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
        authority:'https://nodejs.org/dist/v24.21.0/SHASUMS256.txt',verified:'2026-10-14: HEAD200 and exact official checksum'},
      {name:'Portable dedicated Docker Engine',version:'29.8.2',url:'https://download.docker.com/linux/static/stable/x86_64/docker-29.8.2.tgz',
        bytes:85591344,sha256:'995d1ef289677f74fd58d8d2c35727b6a4ee389c69db8638a3e42d0487aa5b0f',
        authority:'docs/tasks/C1_ISOLATED_RUNNER.md section11.4: prior actual archive hash; not an upstream signed checksum',
        verified:'2026-10-14: HEAD200; downloaded bytes must still be checked'},
      {name:'GCC compiler OCI',manifest:'sha256:980e5c2310bee44d11ee46964174cc11dfea822ba60f0d050d2161d63b64b8f5',
        config:'sha256:9f14e671a09bc195b93ca39524b8dcf401bc832b0c520e462327ce94986799aa',compressedLayerBytes:552569745,layers:8,
        authority:'apps/teaching/runner/import-gcc.ps1; docs/tasks/C1_ISOLATED_RUNNER.md section4/14'},
      {name:'HDL base OCI',manifest:'sha256:f610ab94648195aa356059f5b41d6085c9d4d903c072430cdd1af7bdb646106b',
        authority:'apps/teaching/runner/import-hdl-base.ps1; apps/teaching/runner/hdl.Dockerfile',compressedBytes:'Not yet read; verify manifest/layer/diff_id before import'},
    ],
    installScope:{hostPackages:['qemu-system-x86','qemu-utils','cloud-image-utils'],
      guestPortable:['Node24.21.0','Docker29.8.2'],guestRequiredFeatures:['systemd','cgroupv2','seccomp','AppArmor enforce','overlay2','openssh-server'],
      icarusPackage:'iverilog=12.0-2build2 in the original frozen HDL image; no main/H3 image rebuild or silent image-ID substitution',
      compilerValidation:'Preserve the approved C compiler/runtime and all original limits',
      avoid:['Personal Docker Desktop daemon as the execution boundary','Global .wslconfig edits','Any PAHER install/SSH/key access','Package removal','Prune/old-data deletion']},
    retainedPublicSources:[
      'apps/teaching/runner/vm.sh','apps/teaching/runner/install-node.sh','apps/teaching/runner/hdl-install.sh',
      'apps/teaching/runner/hdl-prepare.ts','apps/teaching/runner/hdl.Dockerfile','apps/teaching/runner/hdl.apparmor',
      'apps/teaching/runner/import-gcc.ps1','apps/teaching/runner/import-hdl-base.ps1',
      'apps/teaching/server/app/initialize.ts','apps/teaching/server/app/config.ts',
      'apps/teaching/runner/acceptance.ts','apps/teaching/runner/hdl-acceptance.ts',
    ],
    localSecretsProposal:{authorizationRequired:true,
      maintenancePrivateKey:'/opt/xunjie-runner/vm/keys/maintenance',applicationPrivateKey:'/opt/xunjie-runner/vm/keys/application',
      keyAlgorithm:'Ed25519; two newly generated local-only pairs; private directory0700/files0600',
      knownHosts:'/opt/xunjie-runner/vm/keys/known_hosts',
      guestHostIdentity:'Fresh cloud guest generates new host keys; pin its public key through the owned local boot/control channel',
      applicationRestriction:'Reuse original forced Node command; no TTY, forwarding, arbitrary shell or maintenance recovery authority',
      signingSecret:'/opt/xunjie-ui-local/signing-secret.txt',signingBytes:32,
      initializer:'/opt/xunjie-ui-local/initializer.json',configuration:'/opt/xunjie-ui-local/application-config.json',
      syntheticPasswords:'Fresh 24-byte random base64url passwords; existing PAHER passwords are not fetched or reused',
      modelApiKey:'Robert DEEPSEEK_API_KEY in temporary local ProcessStartInfo environment plus WSLENV for that child only; no key argv/file/global env edits/PAHER transfer'},
    freshDatabaseProposal:{authorizationRequired:true,kind:'Existing 35-table schema; fresh synthetic-only database, no migration',
      factory:'initializeSyntheticApplication in apps/teaching/server/app/initialize.ts',
      tmpdir:'/opt/xunjie-ui-local/retained-tmp',
      actualFile:'TMPDIR/xunjie-a12-completion-<fresh random>/synthetic.sqlite (factory-selected; preserve openSyntheticDatabase path validation)',
      accounts:['synthetic-robert-teacher','synthetic-robert-student-a','synthetic-robert-student-b'],
      courses:['synthetic-robert-course-c','synthetic-robert-course-hdl'],
      initializeAfter:'Real current local C and HDL readiness share the new local recoveryGeneration; record exact local image/source/validation identity',
      activityFlow:'Original authenticated teacher APIs: checks -> release -> assignments -> ordinary student Session/bootstrap',
      neverImport:['PAHER Session tokens','Old Job/Session/Operation state','Original recovery generation as local authority','Original validation.json as local passed'],
      preserve:'Original C and HDL protocols, teacher/student policy and all Job/engine limits'},
    tls:{newCertificate:false,newRootTrust:false,reuseExactLocalCertificate:true,certFile:tlsCertificate,keyFileReference:tlsKey,
      linuxControlledCopies:{key:'/opt/xunjie-ui-local/tls/server.key.pem',cert:'/opt/xunjie-ui-local/tls/server.crt.pem',mode:'Root-only directory0700/files0600; same existing local key/leaf, no regeneration or extra trust'},
      certificateSha256,thumbprint:'675CD4606DD1CCC8A8E561BD16EA15FC1ABBF34D',origin:'https://127.0.0.1:3444',
      parallelEntry:'Preserve existing3443 gateway/process/config/traffic; do not switch or stop it',
      browser:'Use the already connected Chrome profile isolated from parallel acceptance; same127.0.0.1 cookies are not port-isolated, so verify and exit only this task owned old3443 page before moving its tab to3444',
      note:'Only the existing exact local private key/leaf may be copied to the above controlled local paths after approval; never print their bodies or duplicate into the repository.'},
    copyBoundary:{mayReuse:['Public fixed OS/OCI archives after digest checks','Repository code/locks and owned validated UI dist','Public course/board configuration and synthetic source examples'],
      doNotCopy:['PAHER guest.qcow2 or seed.iso','PAHER maintenance/application/host private keys','PAHER signing secret/initializer/passwords/model key',
        'PAHER database and execution ledger as a shortcut','Old readiness/validation as local authority']},
    capacity:{guestVirtualMaximumBytes:20*gib,knownPublicCompressedBytes:625612288+31890184+85591344+552569745,
      minimumFreeSpacePlanningBytes:25*gib,meaning:'Planning allowance for20GiB dynamic guest, retained downloads, unpacked images and app dependencies; actual usage must be observed',
      measuredWindowsD20261014:{freeBytes:166116524032,physicalMemoryBytes:33820106752}},
    verification:{requiredBeforeBrowser:['Guest has no host/app/Windows mounts; dedicated Engine and original effective limits',
      'Current local C/HDL acceptance and source/image/kernel/engine fingerprints; no historical passed import',
      'New35-table host strict TLS/Session/bootstrap/readiness; model unavailable path remains usable',
      'Owned real HDL browser error -> genuine model/C3 displayed -> explicit revision -> new build/load -> actual changed outputs -> confirmed stop'],
      notAutomaticallyClaimed:['H3 full-domain/teacher binding','Original PAHER objects migrated','Human learning or teacher semantic acceptance','All AC/NFR performance matrices']},
  };
}
function metadata(path) {
  if(!existsSync(path))return {path,exists:false};
  const stat=lstatSync(path);
  return {path,exists:true,file:stat.isFile(),symbolicLink:stat.isSymbolicLink(),bytes:stat.size};
}
function decodeNative(buffer) {
  if(!buffer?.length)return '';
  const bytes=Buffer.from(buffer);
  return (bytes.includes(0)?bytes.toString('utf16le'):bytes.toString('utf8')).replace(/^\uFEFF/,'').trim();
}
/** Readonly metadata only. Never starts a stopped WSL distro, Docker, VM or service. */
export function localReadonlyPreflight() {
  const result={executedAt:new Date().toISOString(),mutationsPerformed:false,privateFileBodiesRead:false,platform:process.platform,node:process.version,
    existingTls:{certificate:metadata(tlsCertificate),keyReference:metadata(tlsKey)},wsl:{checked:false,started:false}};
  if(result.existingTls.certificate.exists) {
    const certificate=new X509Certificate(readFileSync(tlsCertificate)); // Public certificate only.
    result.existingTls.publicCertificate={sha256:certificate.fingerprint256.replaceAll(':','').toLowerCase(),ca:certificate.ca,
      validFrom:certificate.validFrom,validTo:certificate.validTo,loopbackIP:certificate.checkIP('127.0.0.1')??null,localhost:certificate.checkHost('localhost')??null};
    result.existingTls.matchesApprovedLeaf=result.existingTls.publicCertificate.sha256===certificateSha256;
  }
  if(process.platform!=='win32'){result.wsl.reason='Windows host preflight must run on Robert laptop; no Linux service probes performed';return result;}
  const running=spawnSync('wsl.exe',['--list','--running','--quiet'],{timeout:10000,windowsHide:true});
  if(running.status!==0){result.wsl.reason='WSL running-distro inventory unavailable';return result;}
  const names=decodeNative(running.stdout).split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  result.wsl={checked:true,runningDistributions:names,started:false};
  if(!names.includes('Ubuntu')){result.wsl.reason='Ubuntu is stopped; deliberately did not start it';return result;}
  const shell=`printf 'kernel='; uname -r; printf 'pid1='; cat /proc/1/comm; printf 'kvm='; if test -c /dev/kvm; then printf 'present\\n'; else printf 'absent\\n'; fi; printf 'prefix='; if test -e /opt/xunjie-runner; then printf 'exists-inspect-first\\n'; else printf 'absent\\n'; fi; printf 'qemu='; command -v qemu-system-x86_64 || true; printf 'cloudLocalDs='; command -v cloud-localds || true`;
  const probe=spawnSync('wsl.exe',['-d','Ubuntu','-u','root','--','sh','-c',shell],{timeout:10000,windowsHide:true});
  if(probe.status!==0){result.wsl.reason='Readonly Ubuntu metadata probe did not complete';return result;}
  result.wsl.metadata=Object.fromEntries(decodeNative(probe.stdout).split(/\r?\n/).map(line=>{const index=line.indexOf('=');return index<0?[line,'']:[line.slice(0,index),line.slice(index+1)];}));
  return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if(args.some(arg=>!['--preflight','--help'].includes(arg)))throw new Error('Only --preflight or --help is supported. This tool never applies a plan.');
  if(args.includes('--help'))process.stdout.write('node tools/i0-hdl/local-environment-plan.mjs [--preflight]\nOutputs the reviewable local-only plan. Optional preflight reads public TLS/file/WSL metadata only; no downloads, secret reads, installs or stopped-distro startup.\n');
  else process.stdout.write(JSON.stringify({...localEnvironmentPlan(),...(args.includes('--preflight')?{readonlyPreflight:localReadonlyPreflight()}:{})},null,2)+'\n');
}
