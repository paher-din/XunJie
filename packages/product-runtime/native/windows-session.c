/* Windows product session launcher. The host owns profile and fixture preparation. */
#define _WIN32_WINNT 0x0A00
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <userenv.h>
#include <sddl.h>
#include <stdio.h>
#include <wchar.h>

static BOOL configure_startup(STARTUPINFOEXW *startup, SECURITY_CAPABILITIES *capabilities,
                              HANDLE pipes[3], HANDLE *job)
{
    SIZE_T bytes = 0;
    const DWORD streams[] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
    InitializeProcThreadAttributeList(NULL, 3, 0, &bytes);
    startup->lpAttributeList = HeapAlloc(GetProcessHeap(), 0, bytes);
    if (!startup->lpAttributeList ||
        !InitializeProcThreadAttributeList(startup->lpAttributeList, 3, 0, &bytes))
        return FALSE;
    for (size_t i = 0; i < 3; ++i) {
        if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(streams[i]), GetCurrentProcess(),
                             &pipes[i], 0, TRUE, DUPLICATE_SAME_ACCESS))
            return FALSE;
    }
    startup->StartupInfo.cb = sizeof(*startup);
    startup->StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup->StartupInfo.hStdInput = pipes[0];
    startup->StartupInfo.hStdOutput = pipes[1];
    startup->StartupInfo.hStdError = pipes[2];
    return UpdateProcThreadAttribute(startup->lpAttributeList, 0,
               PROC_THREAD_ATTRIBUTE_HANDLE_LIST, pipes, sizeof(HANDLE) * 3, NULL, NULL)
        && UpdateProcThreadAttribute(startup->lpAttributeList, 0,
               PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, capabilities, sizeof(*capabilities), NULL, NULL)
        && UpdateProcThreadAttribute(startup->lpAttributeList, 0,
               PROC_THREAD_ATTRIBUTE_JOB_LIST, job, sizeof(*job), NULL, NULL);
}

static BOOL drain_job(HANDLE job)
{
    if (!TerminateJobObject(job, 1))
        return FALSE;
    ULONGLONG deadline = GetTickCount64() + 3000;
    do {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info = {0};
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                       &info, sizeof(info), NULL))
            return FALSE;
        if (info.ActiveProcesses == 0)
            return TRUE;
        Sleep(10);
    } while (GetTickCount64() < deadline);
    SetLastError(ERROR_TIMEOUT);
    return FALSE;
}

int wmain(int argc, wchar_t **argv)
{
    if (argc == 3 && wcscmp(argv[1], L"--stop") == 0) {
        HANDLE stop = OpenEventW(EVENT_MODIFY_STATE, FALSE, argv[2]);
        if (!stop)
            return 125;
        BOOL signalled = SetEvent(stop);
        CloseHandle(stop);
        return signalled ? 0 : 125;
    }
    if (argc == 3 && wcscmp(argv[1], L"--prepare") == 0) {
        PSID identity = NULL;
        HRESULT status = CreateAppContainerProfile(argv[2], argv[2], L"XunJie native session", NULL, 0, &identity);
        if (FAILED(status)) {
            fprintf(stderr, "CreateAppContainerProfile: 0x%lx\n", (unsigned long)status);
            return 125;
        }
        LPWSTR sid_text = NULL;
        BOOL converted = ConvertSidToStringSidW(identity, &sid_text);
        FreeSid(identity);
        if (!converted)
            return 125;
        wprintf(L"%ls\n", sid_text);
        LocalFree(sid_text);
        return 0;
    }
    if (argc == 3 && wcscmp(argv[1], L"--release") == 0)
        return SUCCEEDED(DeleteAppContainerProfile(argv[2])) ? 0 : 125;
    if (argc != 6) {
        fputs("Expected profile, fixed Node path, session directory, Node command line and stop event.\n", stderr);
        return 125;
    }
    PSID sid = NULL;
    if (FAILED(DeriveAppContainerSidFromAppContainerName(argv[1], &sid))) {
        fputs("Cannot derive session AppContainer identity.\n", stderr);
        return 125;
    }

    SECURITY_CAPABILITIES capabilities = {0};
    capabilities.AppContainerSid = sid;
    STARTUPINFOEXW startup = {0};
    HANDLE pipes[3] = {0};
    HANDLE job = CreateJobObjectW(NULL, NULL);
    HANDLE stop = CreateEventW(NULL, TRUE, FALSE, argv[5]);
    DWORD stop_error = GetLastError();
    PROCESS_INFORMATION child = {0};
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_JOB_MEMORY;
    limits.JobMemoryLimit = 128 * 1024 * 1024;
    limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    limits.BasicLimitInformation.ActiveProcessLimit = 1;
    int result = 125;
    const char *step = "create job";
    if (!job)
        goto fail;
    step = "create session stop event";
    if (!stop || stop_error == ERROR_ALREADY_EXISTS) {
        SetLastError(stop_error);
        goto fail;
    }
    step = "set job limits";
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
        goto fail;
    step = "configure restricted startup";
    if (!configure_startup(&startup, &capabilities, pipes, &job))
        goto fail;
    step = "create suspended AppContainer";
    if (!CreateProcessW(argv[2], argv[4], NULL, NULL, TRUE,
                        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
                        NULL, argv[3], &startup.StartupInfo, &child))
        goto fail;
    for (size_t i = 0; i < 3; ++i) {
        CloseHandle(pipes[i]);
        pipes[i] = NULL;
    }
    step = "resume child";
    if (ResumeThread(child.hThread) != 1)
        goto fail;
    step = "wait for child";
    HANDLE signals[] = {child.hProcess, stop};
    DWORD waited = WaitForMultipleObjects(2, signals, FALSE, INFINITE);
    DWORD code = 0;
    if (waited == WAIT_OBJECT_0) {
        if (!GetExitCodeProcess(child.hProcess, &code))
            goto fail;
    } else if (waited != WAIT_OBJECT_0 + 1) {
        goto fail;
    }
    step = "confirm job empty";
    if (!drain_job(job))
        goto fail;
    result = code == 0 ? 0 : 1;
    goto cleanup;

fail:
    fprintf(stderr, "%s: Windows error %lu\n", step, GetLastError());
cleanup:
    if (stop)
        CloseHandle(stop);
    if (job)
        CloseHandle(job);
    if (child.hThread)
        CloseHandle(child.hThread);
    if (child.hProcess)
        CloseHandle(child.hProcess);
    for (size_t i = 0; i < 3; ++i) {
        if (pipes[i])
            CloseHandle(pipes[i]);
    }
    if (startup.lpAttributeList) {
        if (startup.StartupInfo.cb)
            DeleteProcThreadAttributeList(startup.lpAttributeList);
        HeapFree(GetProcessHeap(), 0, startup.lpAttributeList);
    }
    FreeSid(sid);
    return result;
}
