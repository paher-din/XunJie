#!/usr/bin/env python3
"""Read only resource sampler; durable JSONL, no process argv or configuration."""
import argparse, datetime, json, pathlib, subprocess, time

UNITS = ('xunjie-candidate-128.service', 'xunjie-dev-access-candidate129.service', 'xunjie-shared.service')

def read(path):
    try: return pathlib.Path(path).read_text().strip()
    except OSError: return None

def fields(path):
    text=read(path)
    return dict(line.split(None,1) for line in text.splitlines() if len(line.split(None,1))==2) if text else {}

def snapshot():
    units={}
    for unit in UNITS:
        output=subprocess.check_output(['systemctl','show',unit,'-p','MainPID','-p','NRestarts','-p','Result','-p','ControlGroup','-p','MemoryMax','-p','MemoryHigh'],text=True)
        state=dict(line.split('=',1) for line in output.splitlines() if '=' in line)
        group=pathlib.Path('/sys/fs/cgroup'+state['ControlGroup'])
        units[unit]={**state,**{name:read(group/name) for name in ['memory.current','memory.peak','memory.events','memory.pressure','cpu.stat','cpu.pressure','io.pressure']}}
        pid=state.get('MainPID','0')
        proc=fields('/proc/'+pid+'/status')
        units[unit]['process']={k:proc[k] for k in ['VmRSS:','VmHWM:','Threads:'] if k in proc}
    mem=fields('/proc/meminfo')
    return {'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'monotonic':time.monotonic(),'units':units,
            'host':{'memory':{k:mem[k] for k in ['MemTotal:','MemAvailable:','SwapTotal:','SwapFree:'] if k in mem},
                    'cpu':read('/proc/stat').splitlines()[0], 'cpuPressure':read('/proc/pressure/cpu'),
                    'memoryPressure':read('/proc/pressure/memory'),'ioPressure':read('/proc/pressure/io'),
                    'network':read('/proc/net/dev')}}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);parser.add_argument('--seconds',type=int,default=1020)
    args=parser.parse_args();destination=pathlib.Path(args.output)
    if not str(destination).startswith('/var/lib/xunjie/capacity-133/evidence/') or not 30<=args.seconds<=1800:raise ValueError('CAPACITY_SCOPE_REQUIRED')
    destination.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    with destination.open('x') as stream:
        destination.chmod(0o600);end=time.monotonic()+args.seconds
        while True:
            stream.write(json.dumps(snapshot())+'\n');stream.flush()
            if time.monotonic()>=end:break
            time.sleep(min(5,max(0,end-time.monotonic())))

if __name__=='__main__':main()
