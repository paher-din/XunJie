/* Windows AppContainer probe with a disposable, explicitly granted fixture. */
#define _WIN32_WINNT 0x0A00
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <userenv.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

static int worker(const wchar_t *allowed, const wchar_t *outside, const wchar_t *address, unsigned short port)
{
    DWORD result = 0;
    HANDLE token = NULL;
    DWORD app_container = 0, size = 0;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
        return 125;
    if (!GetTokenInformation(token, TokenIsAppContainer, &app_container,
                             sizeof(app_container), &size))
        return 125;
    CloseHandle(token);
    if (app_container)
        result |= 8;

    HANDLE file = CreateFileW(allowed, GENERIC_READ | GENERIC_WRITE, 0, NULL,
                              OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file != INVALID_HANDLE_VALUE) {
        result |= 1;
        CloseHandle(file);
    }
    file = CreateFileW(outside, GENERIC_READ, 0, NULL, OPEN_EXISTING,
                       FILE_ATTRIBUTE_NORMAL, NULL);
    if (file != INVALID_HANDLE_VALUE) {
        result |= 2;
        CloseHandle(file);
    } else if (GetLastError() != ERROR_ACCESS_DENIED) {
        return 126;
    }

    file = CreateFileW(outside, GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
                       FILE_ATTRIBUTE_NORMAL, NULL);
    if (file != INVALID_HANDLE_VALUE) {
        result |= 32;
        CloseHandle(file);
    } else if (GetLastError() != ERROR_ACCESS_DENIED) {
        return 126;
    }

    WSADATA data;
    if (WSAStartup(MAKEWORD(2, 2), &data))
        return 127;
    SOCKET client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (client == INVALID_SOCKET) {
        if (WSAGetLastError() != WSAEACCES)
            return 127;
    } else {
        struct sockaddr_in endpoint = {0};
        endpoint.sin_family = AF_INET;
        endpoint.sin_port = htons(port);
        if (InetPtonW(AF_INET, address, &endpoint.sin_addr) != 1)
            return 127;
        unsigned long nonblocking = 1;
        if (ioctlsocket(client, FIONBIO, &nonblocking) != 0)
            return 127;
        if (connect(client, (struct sockaddr *)&endpoint, sizeof(endpoint)) == 0) {
            result |= 4;
        } else if (WSAGetLastError() == WSAEWOULDBLOCK) {
            fd_set writable, failed;
            FD_ZERO(&writable);
            FD_ZERO(&failed);
            FD_SET(client, &writable);
            FD_SET(client, &failed);
            struct timeval timeout = {1, 0};
            int ready = select(0, NULL, &writable, &failed, &timeout);
            if (ready == 0)
                result |= 16;
            else if (ready > 0 && FD_ISSET(client, &writable))
                result |= 4;
            else if (ready < 0)
                return 128;
        } else if (WSAGetLastError() != WSAEACCES) {
            return 128;
        }
        closesocket(client);
    }
    WSACleanup();
    return (int)result;
}

int wmain(int argc, wchar_t **argv)
{
    if (argc == 6 && wcscmp(argv[1], L"worker") == 0)
        return worker(argv[2], argv[3], argv[4], (unsigned short)wcstoul(argv[5], NULL, 10));

    PSID sid = NULL;
    const wchar_t *profile = GetEnvironmentVariableW(L"XJ_PROBE_SECOND_PROFILE", NULL, 0)
        ? L"XunJie.NativeSession.Probe.Second" : L"XunJie.NativeSession.Probe";
    HRESULT status = CreateAppContainerProfile(profile,
                                               L"XunJie Native Session Probe", L"Windows isolation probe",
                                               NULL, 0, &sid);
    if (status == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS))
        status = DeriveAppContainerSidFromAppContainerName(profile, &sid);
    if (FAILED(status)) {
        fprintf(stderr, "AppContainer profile: 0x%lx\n", (unsigned long)status);
        return 1;
    }
    if (argc == 2 && wcscmp(argv[1], L"sid") == 0) {
        LPWSTR text = NULL;
        if (!ConvertSidToStringSidW(sid, &text))
            return 1;
        wprintf(L"%ls\n", text);
        LocalFree(text);
        FreeSid(sid);
        return 0;
    }
    BOOL node_probe = argc == 5 && wcscmp(argv[2], L"node") == 0;
    BOOL adapter_probe = argc == 5 && wcscmp(argv[2], L"adapter") == 0;
    if (argc != 6 && !node_probe && !adapter_probe)
        return 1;

    SECURITY_CAPABILITIES capabilities = {0};
    capabilities.AppContainerSid = sid;
    STARTUPINFOEXW startup = {0};
    startup.StartupInfo.cb = sizeof(startup);
    SIZE_T bytes = 0;
    DWORD attribute_count = adapter_probe ? 2 : 1;
    InitializeProcThreadAttributeList(NULL, attribute_count, 0, &bytes);
    startup.lpAttributeList = HeapAlloc(GetProcessHeap(), 0, bytes);
    if (!startup.lpAttributeList ||
        !InitializeProcThreadAttributeList(startup.lpAttributeList, attribute_count, 0, &bytes) ||
        !UpdateProcThreadAttribute(startup.lpAttributeList, 0,
                                   PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                   &capabilities, sizeof(capabilities), NULL, NULL)) {
        fprintf(stderr, "AppContainer startup attributes: %lu\n", GetLastError());
        return 1;
    }
    wchar_t command[32768];
    HANDLE pipes[3];
    if (adapter_probe) {
        const DWORD std_handles[] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
        for (size_t index = 0; index < 3; index++) {
            if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(std_handles[index]),
                                 GetCurrentProcess(), &pipes[index], 0, TRUE,
                                 DUPLICATE_SAME_ACCESS)) {
                fprintf(stderr, "DuplicateHandle: %lu\n", GetLastError());
                return 1;
            }
        }
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = pipes[0];
        startup.StartupInfo.hStdOutput = pipes[1];
        startup.StartupInfo.hStdError = pipes[2];
        if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0,
                                       PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                       pipes, sizeof(pipes), NULL, NULL)) {
            fprintf(stderr, "AppContainer standard handles: %lu\n", GetLastError());
            return 1;
        }
    }
    if (node_probe)
        swprintf(command, 32768, L"\"%ls\" --max-old-space-size=32 --input-type=module --eval "
                 L"\"import fs from 'node:fs';fs.readFileSync(process.argv[1]);"
                 L"try{fs.readFileSync(process.argv[2]);process.exit(42)}"
                 L"catch(e){process.exit(['EACCES','EPERM'].includes(e.code)?43:1)}\" \"%ls\" \"%ls\"",
                 argv[1], argv[3], argv[4]);
    else if (!adapter_probe)
        swprintf(command, 32768, L"\"%ls\" worker \"%ls\" \"%ls\" %ls %ls",
                 argv[1], argv[2], argv[3], argv[4], argv[5]);
    HANDLE job = CreateJobObjectW(NULL, NULL);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_JOB_MEMORY;
    limits.JobMemoryLimit = 128 * 1024 * 1024;
    if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                         &limits, sizeof(limits))) {
        fprintf(stderr, "AppContainer job setup: %lu\n", GetLastError());
        return 1;
    }
    PROCESS_INFORMATION child = {0};
    BOOL launched = CreateProcessW(argv[1], adapter_probe ? argv[3] : command,
                                   NULL, NULL, adapter_probe,
                                   EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED, NULL,
                                   adapter_probe ? argv[4] : NULL, &startup.StartupInfo, &child);
    DWORD launch_error = GetLastError();
    if (adapter_probe) {
        for (size_t index = 0; index < 3; index++)
            CloseHandle(pipes[index]);
    }
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    HeapFree(GetProcessHeap(), 0, startup.lpAttributeList);
    FreeSid(sid);
    if (!launched) {
        fprintf(stderr, "AppContainer CreateProcess: %lu\n", launch_error);
        return 1;
    }
    if (!AssignProcessToJobObject(job, child.hProcess) || ResumeThread(child.hThread) != 1) {
        fprintf(stderr, "AppContainer job assignment/resume: %lu\n", GetLastError());
        TerminateProcess(child.hProcess, 1);
        CloseHandle(job);
        CloseHandle(child.hThread);
        CloseHandle(child.hProcess);
        return 1;
    }
    DWORD result = 1;
    DWORD waited = WaitForSingleObject(child.hProcess, 5000);
    if (waited == WAIT_OBJECT_0) {
        if (!GetExitCodeProcess(child.hProcess, &result))
            fprintf(stderr, "GetExitCodeProcess: %lu\n", GetLastError());
    } else {
        fprintf(stderr, "AppContainer wait: %lu\n", waited);
        TerminateProcess(child.hProcess, 1);
    }
    fprintf(stderr, "AppContainer worker exit: 0x%lx\n", result);
    CloseHandle(job);
    CloseHandle(child.hThread);
    CloseHandle(child.hProcess);
    return (int)result;
}
