"""Development probe for Windows Job Object limits and descendant cleanup."""

import ctypes as ct
from ctypes import wintypes as w
import json
import platform
import subprocess
import sys

kernel = ct.WinDLL("kernel32", use_last_error=True)


def bind(name, result, *args):
    function = getattr(kernel, name)
    function.restype = result
    function.argtypes = args
    return function


class BasicLimits(ct.Structure):
    _fields_ = [
        ("process_time", ct.c_int64), ("job_time", ct.c_int64),
        ("flags", w.DWORD), ("min_working_set", ct.c_size_t),
        ("max_working_set", ct.c_size_t), ("active_processes", w.DWORD),
        ("affinity", ct.c_size_t), ("priority", w.DWORD),
        ("scheduling_class", w.DWORD),
    ]


class Limits(ct.Structure):
    _fields_ = [
        ("basic", BasicLimits), ("io", ct.c_uint64 * 6),
        ("process_memory", ct.c_size_t), ("job_memory", ct.c_size_t),
        ("peak_process_memory", ct.c_size_t), ("peak_job_memory", ct.c_size_t),
    ]


def checked(value):
    if not value:
        raise ct.WinError(ct.get_last_error())
    return value


def child():
    allocate = bind("VirtualAlloc", ct.c_void_p, ct.c_void_p, ct.c_size_t, w.DWORD, w.DWORD)
    allocation = allocate(None, 256 << 20, 0x3000, 4)
    print(json.dumps({"allocation_denied": not allocation, "error": ct.get_last_error()}), flush=True)
    descendant = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    print(descendant.pid, flush=True)


def probe():
    create = bind("CreateJobObjectW", w.HANDLE, ct.c_void_p, w.LPCWSTR)
    configure = bind("SetInformationJobObject", w.BOOL, w.HANDLE, ct.c_int, ct.c_void_p, w.DWORD)
    assign = bind("AssignProcessToJobObject", w.BOOL, w.HANDLE, w.HANDLE)
    open_process = bind("OpenProcess", w.HANDLE, w.DWORD, w.BOOL, w.DWORD)
    wait = bind("WaitForSingleObject", w.DWORD, w.HANDLE, w.DWORD)
    close = bind("CloseHandle", w.BOOL, w.HANDLE)
    job = checked(create(None, None))
    descendant = None
    try:
        limits = Limits()
        limits.basic.flags = 0x2000 | 0x200  # KILL_ON_JOB_CLOSE | JOB_MEMORY
        limits.job_memory = 128 << 20
        checked(configure(job, 9, ct.byref(limits), ct.sizeof(limits)))
        # The trusted probe waits for a gate before allocating or launching a descendant.
        with subprocess.Popen(
            [sys.executable, __file__, "--child"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
        ) as process:
            try:
                checked(assign(job, int(process._handle)))
                process.stdin.write("go\n")
                process.stdin.flush()
                memory = json.loads(process.stdout.readline())
                descendant = checked(open_process(0x100000, False, int(process.stdout.readline())))
                if process.wait(timeout=10) != 0 or wait(descendant, 0) != 258:
                    raise RuntimeError("Expected the descendant to outlive the direct child")
            finally:
                if process.poll() is None:
                    process.kill()
        checked(close(job))
        job = None
        descendant_exited = wait(descendant, 5000) == 0
        print(json.dumps({
            "os": platform.platform(), "architecture": platform.machine(),
            "job_memory_bytes": limits.job_memory, "memory": memory,
            "descendant_exited_on_job_close": descendant_exited,
        }))
        if not memory["allocation_denied"] or not descendant_exited:
            raise RuntimeError("Job Object probe failed")
    finally:
        if job:
            close(job)
        if descendant:
            close(descendant)




def probe_supervisor_crash(executable):
    open_process = bind("OpenProcess", w.HANDLE, w.DWORD, w.BOOL, w.DWORD)
    wait = bind("WaitForSingleObject", w.DWORD, w.HANDLE, w.DWORD)
    close = bind("CloseHandle", w.BOOL, w.HANDLE)
    with subprocess.Popen(
        [executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    ) as driver:
        handles = {}
        try:
            for _ in range(3):
                role, pid = driver.stdout.readline().split()
                handles[role] = checked(open_process(0x100000, False, int(pid)))
            if wait(handles["worker"], 5000) != 0 or wait(handles["descendant"], 0) != 258:
                raise RuntimeError("Expected the descendant to outlive the worker")
            if wait(handles["supervisor"], 0) != 258:
                raise RuntimeError("Supervisor exited before crash injection")
            driver.stdin.write("k\n")
            driver.stdin.flush()
            if driver.wait(timeout=10) != 0 or wait(handles["supervisor"], 5000) != 0:
                raise RuntimeError("Supervisor crash injection failed")
            if wait(handles["descendant"], 5000) != 0:
                raise RuntimeError("Descendant survived supervisor termination")
            print(json.dumps({"suspended_assignment": True, "descendant_exited_on_supervisor_crash": True}))
        finally:
            driver.stdin.close()
            for handle in handles.values():
                close(handle)
if __name__ == "__main__":
    if "--child" in sys.argv:
        if sys.stdin.readline() == "go\n":
            child()
    else:
        probe()

        if len(sys.argv) == 3 and sys.argv[1] == "--crash-probe":
            probe_supervisor_crash(sys.argv[2])
