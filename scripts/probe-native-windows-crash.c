/* Windows supervision probe. Build with a Windows C compiler. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

static int fail(const char *step)
{
    fprintf(stderr, "%s failed (Win32 %lu)\n", step, GetLastError());
    return 1;
}

static BOOL start(wchar_t *command, DWORD flags, PROCESS_INFORMATION *process)
{
    STARTUPINFOW info = {0};
    info.cb = sizeof(info);
    return CreateProcessW(NULL, command, NULL, NULL, FALSE, flags,
                          NULL, NULL, &info, process);
}

static int supervise(wchar_t *command, HANDLE ready, unsigned long *worker_id)
{
    HANDLE job = CreateJobObjectW(NULL, NULL);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    PROCESS_INFORMATION worker = {0};
    int result = 1;
    if (!job)
        return fail("CreateJobObject");
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                 &limits, sizeof(limits))) {
        fail("SetInformationJobObject");
        goto cleanup;
    }
    if (!start(command, CREATE_SUSPENDED, &worker)) {
        fail("CreateProcess suspended");
        goto cleanup;
    }
    if (!AssignProcessToJobObject(job, worker.hProcess)) {
        fail("AssignProcessToJobObject");
        TerminateProcess(worker.hProcess, 1);
        goto cleanup;
    }
    if (ResumeThread(worker.hThread) != 1 ||
        WaitForSingleObject(ready, 5000) != WAIT_OBJECT_0) {
        fail("Resume and wait for descendant");
        goto cleanup;
    }
    *worker_id = worker.dwProcessId;
    result = 0;
cleanup:
    if (worker.hThread)
        CloseHandle(worker.hThread);
    if (worker.hProcess)
        CloseHandle(worker.hProcess);
    if (result)
        CloseHandle(job);
    /* The successful supervisor intentionally holds the sole job handle until killed. */
    return result;
}

int wmain(int argc, wchar_t **argv)
{
    wchar_t command[32768];
    wchar_t event_name[80];
    if (argc == 2 && wcscmp(argv[1], L"sleeper") == 0) {
        Sleep(60000);
        return 0;
    }
    if (argc == 3 && wcscmp(argv[1], L"worker") == 0) {
        PROCESS_INFORMATION sleeper = {0};
        HANDLE ready = OpenEventW(EVENT_MODIFY_STATE, FALSE, argv[2]);
        if (!ready)
            return fail("OpenEvent");
        swprintf(command, 32768, L"\"%ls\" sleeper", argv[0]);
        if (!start(command, 0, &sleeper))
            return fail("Create descendant");
        printf("descendant %lu\n", sleeper.dwProcessId);
        fflush(stdout);
        SetEvent(ready);
        CloseHandle(ready);
        CloseHandle(sleeper.hThread);
        CloseHandle(sleeper.hProcess);
        return 0;
    }
    if (argc == 3 && wcscmp(argv[1], L"supervisor") == 0) {
        unsigned long worker_id;
        HANDLE ready = OpenEventW(SYNCHRONIZE, FALSE, argv[2]);
        if (!ready)
            return fail("OpenEvent supervisor");
        swprintf(command, 32768, L"\"%ls\" worker %ls", argv[0], argv[2]);
        int result = supervise(command, ready, &worker_id);
        CloseHandle(ready);
        if (result)
            return result;
        printf("worker %lu\n", worker_id);
        fflush(stdout);
        Sleep(60000);
        return 0;
    }
    swprintf(event_name, 80, L"Local\\XunJieNativeJobProbe-%lu", GetCurrentProcessId());
    HANDLE ready = CreateEventW(NULL, TRUE, FALSE, event_name);
    PROCESS_INFORMATION supervisor = {0};
    if (!ready)
        return fail("CreateEvent");
    swprintf(command, 32768, L"\"%ls\" supervisor %ls", argv[0], event_name);
    if (!start(command, 0, &supervisor))
        return fail("Create supervisor");
    /* The Python driver reads process IDs and holds their handles before asking us to kill. */
    printf("supervisor %lu\n", supervisor.dwProcessId);
    fflush(stdout);
    int result = getchar() != 'k';
    if (!TerminateProcess(supervisor.hProcess, 42))
        result = fail("Terminate supervisor");
    if (WaitForSingleObject(supervisor.hProcess, 5000) != WAIT_OBJECT_0)
        result = fail("Wait for supervisor");
    CloseHandle(supervisor.hThread);
    CloseHandle(supervisor.hProcess);
    CloseHandle(ready);
    return result;
}
