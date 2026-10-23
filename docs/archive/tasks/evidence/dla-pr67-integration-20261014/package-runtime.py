"""Retained runtime package from exact Git blobs; excludes all credentials and untracked dependencies."""
import hashlib, io, json, pathlib, subprocess, sys, tarfile
root=pathlib.Path(__file__).resolve().parents[4]
commit=sys.argv[1]
output=pathlib.Path(sys.argv[2]);output.mkdir(parents=True,exist_ok=False)
entries=subprocess.check_output(['git','ls-tree','-r','-z',commit],cwd=root).split(b'\0')
selected=[]
for entry in entries:
    if not entry:continue
    metadata,name=entry.split(b'\t',1);mode,kind,sha=metadata.decode().split();path=name.decode()
    if path.startswith(('apps/','tools/i0-ui55/')) or path in (
      'docs/tasks/evidence/dla-pr67-integration-20261014/serve-i0.mjs',
      'docs/tasks/evidence/dla-continuation-20261014/serve-hdl.mjs'):
        assert kind=='blob' and mode in ('100644','100755')
        selected.append((path,mode,sha))
process=subprocess.Popen(['git','cat-file','--batch'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE)
files=[]
with tarfile.open(output/'runtime.tar','w') as archive:
    for path,mode,sha in selected:
        process.stdin.write((sha+'\n').encode());process.stdin.flush()
        header=process.stdout.readline().decode().split();assert header[0]==sha and header[1]=='blob'
        size=int(header[2]);data=process.stdout.read(size);assert process.stdout.read(1)==b'\n'
        assert len(data)==size
        item=tarfile.TarInfo('XunJie/'+path);item.size=size;item.mode=int(mode,8)&0o777;item.mtime=0
        archive.addfile(item,io.BytesIO(data))
        files.append({'path':path,'gitBlob':sha,'bytes':size,'mode':item.mode,'sha256':hashlib.sha256(data).hexdigest()})
process.stdin.close();assert process.wait()==0
value={'sourceCommit':commit,'files':files,'archiveSha256':hashlib.sha256((output/'runtime.tar').read_bytes()).hexdigest(),
       'scope':'exact tracked runtime/application/UI/tools; no credentials, configs, databases, dependencies or local candidate'}
(output/'manifest.json').write_text(json.dumps(value,indent=2)+'\n')
print(json.dumps({'sourceCommit':commit,'files':len(files),'archiveSha256':value['archiveSha256'],'directory':str(output)}))
