// Photoshop Supreme MCP - silent one-click installer / daemon launcher (Windows, per-user, no admin needed).
//
//   PhotoshopSupremeMCP-Setup.exe             clean reinstall: removes the old version, installs the new one. No console window.
//   PhotoshopSupremeMCP-Setup.exe --uninstall remove everything
//   PhotoshopSupremeMCP-Setup.exe --silent    same as install but without the final message box
//   PhotoshopSupremeMCP-Setup.exe --use-cc    install the Photoshop plugin through Creative Cloud (UPIA) instead of directly
//   PhotoshopSupremeMCP.exe --daemon          (internal) hidden watchdog that keeps the MCP daemon alive
//
// BUILD AS A WINDOWS-SUBSYSTEM APP so no console flashes:
//   Visual Studio: Project > Properties > Linker > System > SubSystem = Windows (/SUBSYSTEM:WINDOWS)
//                  Linker > Advanced > Entry Point = mainCRTStartup      (keep the plain `main` below)
//   or just run installer\build.bat.
// Place the exe in the ROOT of the project folder (next to server\, plugin\, plugin.ccx). Log: %LOCALAPPDATA%\PhotoshopSupremeMCP\install.log

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <urlmon.h>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cwchar>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

#ifdef _MSC_VER
#pragma comment(lib, "urlmon.lib")
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "shell32.lib")
#endif

namespace fs = std::filesystem;

// ------------------------------------------------------------------ constants
static const wchar_t* kAppName = L"Photoshop Supreme MCP";
static const wchar_t* kInstallDirName = L"PhotoshopSupremeMCP";
static const wchar_t* kInstalledExe = L"PhotoshopSupremeMCP.exe";
static const wchar_t* kRunKey = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
static const wchar_t* kRunValue = L"PhotoshopSupremeMCP";
static const wchar_t* kPluginId = L"com.eagle.photoshop-supreme-mcp";
static const int kHttpPort = 38461;
static const int kMinNodeMajor = 18;
// Portable Node used only when no Node >= 18 is found. Change here to update.
static const char* kNodeVersion = "v22.11.0";

// -------------------------------------------------------------------- output
// No console window: everything goes to a log file; if launched from a terminal it is mirrored there too.
static std::string toUtf8(const std::wstring& w);
static std::wstring g_logPath;
static HANDLE g_con = nullptr;
static std::vector<std::wstring> g_warns;

static void initConsole() {
  if (AttachConsole(ATTACH_PARENT_PROCESS)) {
    g_con = CreateFileW(L"CONOUT$", GENERIC_WRITE, FILE_SHARE_WRITE | FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
    if (g_con == INVALID_HANDLE_VALUE) g_con = nullptr;
  }
}
static void emit(const std::wstring& s) {
  if (g_con) {
    std::wstring line = s + L"\r\n";
    DWORD w = 0;
    WriteConsoleW(g_con, line.c_str(), (DWORD)line.size(), &w, nullptr);
  }
  if (!g_logPath.empty()) {
    std::ofstream f(fs::path(g_logPath), std::ios::binary | std::ios::app);
    f << toUtf8(s) << "\r\n";
  }
}
static void say(const std::wstring& s) { emit(s); }
static void step(const std::wstring& s) { emit(L"\n== " + s); }
static void ok(const std::wstring& s) { emit(L"  [ok] " + s); }
static void warn(const std::wstring& s) { g_warns.push_back(s); emit(L"  [!!] " + s); }
static void info(const std::wstring& s) { emit(L"       " + s); }

static std::wstring fromUtf8(const std::string& s) {
  if (s.empty()) return L"";
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &w[0], n);
  return w;
}
static std::string toUtf8(const std::wstring& w) {
  if (w.empty()) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), &s[0], n, nullptr, nullptr);
  return s;
}
static std::wstring lower(std::wstring s) {
  for (auto& c : s) c = (wchar_t)towlower(c);
  return s;
}
static std::wstring quote(const fs::path& p) { return L"\"" + p.wstring() + L"\""; }

static std::wstring env(const wchar_t* name) {
  std::vector<wchar_t> buf(32768);
  DWORD n = GetEnvironmentVariableW(name, buf.data(), (DWORD)buf.size());
  return n ? std::wstring(buf.data(), n) : L"";
}

// ------------------------------------------------------------------- process
struct RunResult {
  bool started = false;
  bool timedOut = false;
  DWORD code = (DWORD)-1;
  std::string out;
};

static RunResult runProc(const std::wstring& cmd, DWORD timeoutMs = 300000, const std::wstring& cwd = L"") {
  RunResult res;
  SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
  HANDLE rd = nullptr, wr = nullptr;
  if (!CreatePipe(&rd, &wr, &sa, 0)) return res;
  SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;
  si.hStdOutput = wr;
  si.hStdError = wr;
  HANDLE nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
  si.hStdInput = nul;
  PROCESS_INFORMATION pi{};
  std::vector<wchar_t> buf(cmd.begin(), cmd.end());
  buf.push_back(0);
  BOOL created = CreateProcessW(nullptr, buf.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr,
                                cwd.empty() ? nullptr : cwd.c_str(), &si, &pi);
  CloseHandle(wr);
  if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
  if (!created) {
    CloseHandle(rd);
    return res;
  }
  res.started = true;
  DWORD start = GetTickCount();
  char tmp[4096];
  auto drain = [&]() {
    DWORD avail = 0;
    while (PeekNamedPipe(rd, nullptr, 0, nullptr, &avail, nullptr) && avail) {
      DWORD got = 0;
      if (!ReadFile(rd, tmp, sizeof(tmp), &got, nullptr) || !got) break;
      res.out.append(tmp, got);
    }
  };
  for (;;) {
    drain();
    if (WaitForSingleObject(pi.hProcess, 50) == WAIT_OBJECT_0) {
      drain();
      break;
    }
    if (GetTickCount() - start > timeoutMs) {
      TerminateProcess(pi.hProcess, 1);
      res.timedOut = true;
      break;
    }
  }
  GetExitCodeProcess(pi.hProcess, &res.code);
  CloseHandle(pi.hProcess);
  CloseHandle(pi.hThread);
  CloseHandle(rd);
  return res;
}

static void printIndented(const std::string& out) {
  std::istringstream is(out);
  std::string line;
  while (std::getline(is, line)) {
    while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) line.pop_back();
    if (!line.empty()) info(fromUtf8(line));
  }
}

static bool processRunning(const wchar_t* exeName, DWORD ignorePid = 0) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return false;
  PROCESSENTRY32W pe{sizeof(pe)};
  bool found = false;
  for (BOOL b = Process32FirstW(snap, &pe); b; b = Process32NextW(snap, &pe)) {
    if (_wcsicmp(pe.szExeFile, exeName) == 0 && pe.th32ProcessID != ignorePid) {
      found = true;
      break;
    }
  }
  CloseHandle(snap);
  return found;
}

static int killProcessesNamed(const wchar_t* exeName, DWORD ignorePid) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return 0;
  PROCESSENTRY32W pe{sizeof(pe)};
  int killed = 0;
  for (BOOL b = Process32FirstW(snap, &pe); b; b = Process32NextW(snap, &pe)) {
    if (_wcsicmp(pe.szExeFile, exeName) == 0 && pe.th32ProcessID != ignorePid) {
      HANDLE h = OpenProcess(PROCESS_TERMINATE, FALSE, pe.th32ProcessID);
      if (h) {
        if (TerminateProcess(h, 0)) killed++;
        CloseHandle(h);
      }
    }
  }
  CloseHandle(snap);
  return killed;
}

// ------------------------------------------------------------------- helpers
static fs::path selfPath() {
  std::vector<wchar_t> buf(32768);
  DWORD n = GetModuleFileNameW(nullptr, buf.data(), (DWORD)buf.size());
  return fs::path(std::wstring(buf.data(), n));
}

static bool portOpen(int port) {
  WSADATA w;
  if (WSAStartup(MAKEWORD(2, 2), &w) != 0) return false;
  SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  bool open = false;
  if (s != INVALID_SOCKET) {
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons((u_short)port);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    open = connect(s, (sockaddr*)&a, sizeof(a)) == 0;
    closesocket(s);
  }
  WSACleanup();
  return open;
}

static std::wstring regGetString(HKEY k, const wchar_t* name) {
  DWORD type = 0, size = 0;
  if (RegQueryValueExW(k, name, nullptr, &type, nullptr, &size) != ERROR_SUCCESS) return L"";
  if (type != REG_SZ && type != REG_EXPAND_SZ) return L"";
  std::wstring s(size / sizeof(wchar_t) + 1, L'\0');
  DWORD sz2 = size;
  if (RegQueryValueExW(k, name, nullptr, nullptr, (LPBYTE)&s[0], &sz2) != ERROR_SUCCESS) return L"";
  s.resize(wcslen(s.c_str()));
  return s;
}

static std::string readFile(const fs::path& p) {
  std::ifstream f(p, std::ios::binary);
  std::ostringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

static bool writeFile(const fs::path& p, const std::string& data) {
  std::ofstream f(p, std::ios::binary | std::ios::trunc);
  f << data;
  return (bool)f;
}

// ------------------------------------------------------------- Photoshop scan
struct PhotoshopInstall {
  std::wstring label;
  fs::path exe;
};

static std::vector<PhotoshopInstall> findPhotoshop() {
  std::vector<PhotoshopInstall> found;
  auto add = [&](const std::wstring& label, const fs::path& exe) {
    std::error_code ec;
    if (!fs::exists(exe, ec)) return;
    for (auto& f : found)
      if (lower(f.exe.wstring()) == lower(exe.wstring())) return;
    found.push_back({label, exe});
  };

  HKEY root;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Adobe\\Photoshop", 0, KEY_READ | KEY_WOW64_64KEY, &root) == ERROR_SUCCESS) {
    wchar_t name[256];
    for (DWORD i = 0;; i++) {
      DWORD len = 256;
      if (RegEnumKeyExW(root, i, name, &len, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) break;
      HKEY sub;
      if (RegOpenKeyExW(root, name, 0, KEY_READ | KEY_WOW64_64KEY, &sub) == ERROR_SUCCESS) {
        std::wstring p = regGetString(sub, L"ApplicationPath");
        RegCloseKey(sub);
        if (!p.empty()) add(L"Photoshop (registry " + std::wstring(name) + L")", fs::path(p) / L"Photoshop.exe");
      }
    }
    RegCloseKey(root);
  }
  std::wstring pf = env(L"ProgramW6432");
  if (pf.empty()) pf = L"C:\\Program Files";
  std::error_code ec;
  fs::path adobe = fs::path(pf) / L"Adobe";
  if (fs::exists(adobe, ec)) {
    for (auto& d : fs::directory_iterator(adobe, ec)) {
      std::wstring n = d.path().filename().wstring();
      if (lower(n).rfind(L"adobe photoshop", 0) == 0) add(n, d.path() / L"Photoshop.exe");
    }
  }
  return found;
}

// ----------------------------------------------------------------------- Node
static int nodeMajor(const fs::path& exe) {
  RunResult r = runProc(quote(exe) + L" --version", 15000);
  if (!r.started || r.code != 0) return 0;
  size_t i = r.out.find('v');
  if (i == std::string::npos) return 0;
  return atoi(r.out.c_str() + i + 1);
}

static std::optional<fs::path> findNode(const fs::path& installDir) {
  std::vector<fs::path> cands;
  cands.push_back(installDir / L"runtime" / L"node" / L"node.exe");
  wchar_t found[MAX_PATH];
  if (SearchPathW(nullptr, L"node.exe", nullptr, MAX_PATH, found, nullptr)) cands.push_back(found);
  for (const wchar_t* var : {L"ProgramW6432", L"ProgramFiles"}) {
    std::wstring p = env(var);
    if (!p.empty()) cands.push_back(fs::path(p) / L"nodejs" / L"node.exe");
  }
  std::wstring la = env(L"LOCALAPPDATA");
  if (!la.empty()) cands.push_back(fs::path(la) / L"Programs" / L"nodejs" / L"node.exe");
  for (auto& c : cands) {
    std::error_code ec;
    if (fs::exists(c, ec) && nodeMajor(c) >= kMinNodeMajor) return c;
  }
  return std::nullopt;
}

static std::string sha256Of(const fs::path& file) {
  RunResult r = runProc(L"certutil -hashfile " + quote(file) + L" SHA256", 120000);
  std::istringstream is(r.out);
  std::string line;
  std::getline(is, line);  // header line
  if (std::getline(is, line)) {
    std::string h;
    for (char c : line)
      if (isxdigit((unsigned char)c)) h += (char)tolower((unsigned char)c);
    if (h.size() == 64) return h;
  }
  return "";
}

static std::optional<fs::path> installPortableNode(const fs::path& installDir) {
  std::string ver = kNodeVersion;
  std::string zipName = "node-" + ver + "-win-x64.zip";
  std::string base = "https://nodejs.org/dist/" + ver + "/";
  fs::path rt = installDir / L"runtime";
  std::error_code ec;
  fs::create_directories(rt, ec);
  fs::path zip = rt / fromUtf8(zipName);
  fs::path sums = rt / L"SHASUMS256.txt";

  info(L"Downloading Node.js " + fromUtf8(ver) + L" (portable, ~30 MB)...");
  if (URLDownloadToFileW(nullptr, fromUtf8(base + zipName).c_str(), zip.c_str(), 0, nullptr) != S_OK) {
    warn(L"Could not download Node.js (no internet?).");
    return std::nullopt;
  }
  if (URLDownloadToFileW(nullptr, fromUtf8(base + "SHASUMS256.txt").c_str(), sums.c_str(), 0, nullptr) != S_OK) {
    warn(L"Could not download checksum file - refusing to install an unverified runtime.");
    return std::nullopt;
  }
  std::string expected;
  {
    std::istringstream is(readFile(sums));
    std::string line;
    while (std::getline(is, line))
      if (line.find(zipName) != std::string::npos) {
        expected = line.substr(0, line.find(' '));
        break;
      }
  }
  std::string actual = sha256Of(zip);
  if (expected.empty() || actual.empty() || expected != actual) {
    warn(L"Checksum mismatch - deleting download.");
    fs::remove(zip, ec);
    return std::nullopt;
  }
  ok(L"Checksum verified (SHA-256).");

  std::wstring sysroot = env(L"SystemRoot");
  fs::path tar = fs::path(sysroot.empty() ? L"C:\\Windows" : sysroot) / L"System32" / L"tar.exe";
  fs::remove_all(rt / L"node", ec);
  RunResult r = runProc(quote(tar) + L" -xf " + quote(zip) + L" -C " + quote(rt), 300000);
  if (!r.started || r.code != 0) {
    warn(L"Extraction failed (needs Windows 10 1803+ tar.exe).");
    printIndented(r.out);
    return std::nullopt;
  }
  fs::rename(rt / fromUtf8("node-" + ver + "-win-x64"), rt / L"node", ec);
  fs::remove(zip, ec);
  fs::remove(sums, ec);
  fs::path exe = rt / L"node" / L"node.exe";
  if (nodeMajor(exe) >= kMinNodeMajor) return exe;
  return std::nullopt;
}

// --------------------------------------------------------------------- plugin
static fs::path upiaPath() {
  std::wstring c = env(L"CommonProgramW6432");
  if (c.empty()) c = L"C:\\Program Files\\Common Files";
  return fs::path(c) / L"Adobe" / L"Adobe Desktop Common" / L"RemoteComponents" / L"UPI" /
         L"UnifiedPluginInstallerAgent" / L"UnifiedPluginInstallerAgent.exe";
}

static std::optional<fs::path> installedPluginDir() {
  std::wstring ad = env(L"APPDATA");
  if (ad.empty()) return std::nullopt;
  fs::path ext = fs::path(ad) / L"Adobe" / L"UXP" / L"Plugins" / L"External";
  std::error_code ec;
  if (!fs::exists(ext, ec)) return std::nullopt;
  for (auto& d : fs::directory_iterator(ext, ec))
    if (d.path().filename().wstring().rfind(kPluginId, 0) == 0) return d.path();
  return std::nullopt;
}

// ----------------------------------------------------------------- the stages
static fs::path helperScript(const fs::path& installDir) { return installDir / L"server" / L"uxp-plugin.mjs"; }

static RunResult runHelper(const fs::path& node, const fs::path& installDir, const std::wstring& args) {
  return runProc(quote(node) + L" " + quote(helperScript(installDir)) + L" " + args, 60000);
}

/// Remove every previously installed copy (any version) of our plugin. Safe to call when nothing is installed.
static void removeOldPlugin(const fs::path& node, const fs::path& installDir) {
  RunResult r = runHelper(node, installDir, std::wstring(L"--remove --id ") + kPluginId);
  if (r.started && r.out.find("\"ok\":true") != std::string::npos) ok(L"Removed previous plugin version(s) (if any).");
  else { warn(L"Could not clean the old plugin registration."); printIndented(r.out); }
  // All-users location (needs admin to modify; ignore failures).
  std::wstring cp = env(L"CommonProgramW6432");
  if (!cp.empty()) {
    std::error_code ec;
    fs::path ext = fs::path(cp) / L"Adobe" / L"UXP" / L"Plugins" / L"External";
    if (fs::exists(ext, ec))
      for (auto& d : fs::directory_iterator(ext, ec))
        if (d.path().filename().wstring().rfind(kPluginId, 0) == 0) fs::remove_all(d.path(), ec);
  }
}

static bool pluginInstalled(const fs::path& node, const fs::path& installDir) {
  RunResult r = runHelper(node, installDir, std::wstring(L"--status --id ") + kPluginId);
  return r.started && r.out.find("\"installed\":true") != std::string::npos;
}

/// Silent install: copy into Photoshop's per-user plugin folder and register it in PS.json. No Adobe prompt.
static bool installPluginDirect(const fs::path& node, const fs::path& installDir) {
  RunResult r = runHelper(node, installDir, L"--install --src " + quote(installDir / L"plugin"));
  if (!r.started || r.out.find("\"ok\":true") == std::string::npos) {
    warn(L"Direct plugin install failed.");
    printIndented(r.out);
    return false;
  }
  if (!pluginInstalled(node, installDir)) {
    warn(L"Plugin files written but not registered.");
    return false;
  }
  ok(L"Photoshop plugin installed (silent, no Creative Cloud needed).");
  return true;
}

/// Fallback: Adobe's installer agent (may show a "not verified by Adobe" prompt).
static bool installPluginViaCC(const fs::path& installDir, const std::vector<PhotoshopInstall>& ps) {
  fs::path ccx = installDir / L"plugin.ccx";
  fs::path upia = upiaPath();
  std::error_code ec;
  if (!fs::exists(upia, ec)) {
    warn(L"Adobe's Unified Plugin Installer Agent was not found (is Creative Cloud installed?).");
    return false;
  }
  fs::path ccxToUse = ccx;  // must live on the same drive as Photoshop / Creative Cloud
  if (!ps.empty()) {
    std::wstring d1 = lower(ps[0].exe.root_name().wstring()), d2 = lower(ccx.root_name().wstring());
    if (!d1.empty() && d1 != d2) {
      fs::path alt = fs::path(ps[0].exe.root_name().wstring() + L"\\") / L"PhotoshopSupremeMCP-tmp" / L"plugin.ccx";
      fs::create_directories(alt.parent_path(), ec);
      fs::copy_file(ccx, alt, fs::copy_options::overwrite_existing, ec);
      if (!ec) ccxToUse = alt;
    }
  }
  info(L"Installing plugin through Creative Cloud (an Adobe 'not verified' prompt may appear - choose Install)...");
  RunResult r = runProc(quote(upia) + L" /install " + quote(ccxToUse), 240000);
  if (ccxToUse != ccx) fs::remove_all(ccxToUse.parent_path(), ec);
  if (r.timedOut) warn(L"Timed out waiting for Creative Cloud - an Adobe dialog may be waiting for you.");
  printIndented(r.out);
  if (installedPluginDir()) {
    ok(L"Photoshop plugin installed through Creative Cloud.");
    return true;
  }
  warn(L"Creative Cloud did not install the plugin (exit code " + std::to_wstring(r.code) + L").");
  return false;
}

static bool configureHosts(const fs::path& installDir, const fs::path& node) {
  RunResult r = runProc(quote(node) + L" " + quote(installDir / L"server" / L"configure.mjs") + L" --install --node " +
                            quote(node) + L" --server " + quote(installDir / L"server" / L"supreme.mjs"),
                        60000);
  printIndented(r.out);
  return r.started && r.code == 0;
}

static bool registerAndStartDaemon(const fs::path& installDir) {
  fs::path exe = installDir / kInstalledExe;
  std::wstring cmd = quote(exe) + L" --daemon";
  LSTATUS st = RegSetKeyValueW(HKEY_CURRENT_USER, kRunKey, kRunValue, REG_SZ, cmd.c_str(),
                               (DWORD)((cmd.size() + 1) * sizeof(wchar_t)));
  if (st != ERROR_SUCCESS) {
    warn(L"Could not register auto-start (error " + std::to_wstring(st) + L").");
    return false;
  }
  ok(L"Auto-start registered (starts hidden at every login).");

  if (!portOpen(kHttpPort)) {
    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    std::vector<wchar_t> buf(cmd.begin(), cmd.end());
    buf.push_back(0);
    if (CreateProcessW(nullptr, buf.data(), nullptr, nullptr, FALSE, DETACHED_PROCESS | CREATE_NO_WINDOW, nullptr,
                       installDir.c_str(), &si, &pi)) {
      CloseHandle(pi.hProcess);
      CloseHandle(pi.hThread);
    } else {
      warn(L"Could not start the daemon now; it will start at next login.");
      return false;
    }
    for (int i = 0; i < 60 && !portOpen(kHttpPort); i++) Sleep(250);
  }
  if (portOpen(kHttpPort)) {
    ok(L"Daemon is running (127.0.0.1:" + std::to_wstring(kHttpPort) + L").");
    return true;
  }
  warn(L"Daemon did not come up. Check that nothing else uses ports 38460/38461.");
  return false;
}

// ------------------------------------------------------------------- daemon
static int daemonMain() {
  HANDLE mtx = CreateMutexW(nullptr, FALSE, L"Local\\PhotoshopSupremeMCPDaemon");
  if (GetLastError() == ERROR_ALREADY_EXISTS) return 0;  // already running
  if (HWND h = GetConsoleWindow()) ShowWindow(h, SW_HIDE);
  FreeConsole();

  fs::path dir = selfPath().parent_path();
  // Kill the whole process tree if this watchdog is ever terminated.
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION li{};
    li.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(job, JobObjectExtendedLimitInformation, &li, sizeof(li));
    AssignProcessToJobObject(job, GetCurrentProcess());
  }

  DWORD delay = 2000;
  for (;;) {
    std::optional<fs::path> node;
    std::string saved = readFile(dir / L"node-path.txt");
    if (!saved.empty()) {
      fs::path p = fromUtf8(saved);
      std::error_code ec;
      if (fs::exists(p, ec)) node = p;
    }
    if (!node) node = findNode(dir);
    DWORD started = GetTickCount();
    if (node) {
      std::wstring cmd = quote(*node) + L" " + quote(dir / L"server" / L"supreme.mjs") + L" --daemon";
      STARTUPINFOW si{};
      si.cb = sizeof(si);
      PROCESS_INFORMATION pi{};
      std::vector<wchar_t> buf(cmd.begin(), cmd.end());
      buf.push_back(0);
      if (CreateProcessW(nullptr, buf.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, dir.c_str(), &si, &pi)) {
        WaitForSingleObject(pi.hProcess, INFINITE);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
      }
    }
    // Back off if it keeps dying immediately (e.g. port already taken).
    delay = (GetTickCount() - started < 10000) ? (std::min)(delay * 2, (DWORD)30000) : 2000;
    Sleep(delay);
  }
  (void)mtx;
  return 0;
}

// ------------------------------------------------------------------ uninstall
static void finalBox(bool silent, const std::wstring& text, UINT icon) {
  if (!silent) MessageBoxW(nullptr, text.c_str(), kAppName, MB_OK | icon | MB_SETFOREGROUND | MB_TOPMOST);
}

static int uninstallMain(bool silent) {
  std::wstring la = env(L"LOCALAPPDATA");
  fs::path installDir = fs::path(la) / kInstallDirName;
  std::error_code ec;
  fs::create_directories(installDir, ec);
  g_logPath = (installDir / L"install.log").wstring();
  { std::ofstream f(fs::path(g_logPath), std::ios::binary | std::ios::trunc); }
  step(std::wstring(L"Uninstalling ") + kAppName);
  fs::path self = selfPath();

  if (killProcessesNamed(kInstalledExe, GetCurrentProcessId())) ok(L"Stopped daemon.");
  RegDeleteKeyValueW(HKEY_CURRENT_USER, kRunKey, kRunValue);
  ok(L"Auto-start removed.");

  if (auto node = findNode(installDir)) {
    if (fs::exists(helperScript(installDir), ec)) removeOldPlugin(*node, installDir);
    if (fs::exists(installDir / L"server" / L"configure.mjs", ec)) {
      RunResult r = runProc(quote(*node) + L" " + quote(installDir / L"server" / L"configure.mjs") + L" --uninstall", 60000);
      printIndented(r.out);
    }
  }
  std::wstring home = env(L"USERPROFILE");
  if (!home.empty()) fs::remove_all(fs::path(home) / L".photoshop-supreme-mcp", ec);

  Sleep(500);
  bool selfInside = lower(self.wstring()).rfind(lower(installDir.wstring()), 0) == 0;
  if (selfInside) {
    std::wstring cmd = L"cmd /c ping 127.0.0.1 -n 3 >nul & rmdir /s /q " + quote(installDir);
    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    std::vector<wchar_t> buf(cmd.begin(), cmd.end());
    buf.push_back(0);
    if (CreateProcessW(nullptr, buf.data(), nullptr, nullptr, FALSE, DETACHED_PROCESS | CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
      CloseHandle(pi.hProcess);
      CloseHandle(pi.hThread);
    }
  } else {
    fs::remove_all(installDir, ec);
  }
  ok(L"Uninstalled.");
  finalBox(silent, std::wstring(kAppName) + L" was removed.\n\nRestart Photoshop and your AI app to finish.", MB_ICONINFORMATION);
  return 0;
}

// -------------------------------------------------------------------- install
static int installMain(const fs::path& payloadDir, bool silent, bool useCC) {
  std::wstring la = env(L"LOCALAPPDATA");
  if (la.empty()) {
    finalBox(silent, L"%LOCALAPPDATA% is not set.", MB_ICONERROR);
    return 1;
  }
  fs::path installDir = fs::path(la) / kInstallDirName;
  std::error_code ec;
  fs::create_directories(installDir, ec);
  g_logPath = (installDir / L"install.log").wstring();
  { std::ofstream f(fs::path(g_logPath), std::ios::binary | std::ios::trunc); }

  say(std::wstring(kAppName) + L" - installer");

  step(L"Checking package");
  for (const wchar_t* need : {L"server\\supreme.mjs", L"server\\configure.mjs", L"server\\uxp-plugin.mjs", L"plugin.ccx", L"plugin\\manifest.json"}) {
    if (!fs::exists(payloadDir / need, ec)) {
      warn(std::wstring(L"Missing ") + need);
      info(L"Put this exe in the ROOT of the Photoshop Supreme MCP folder (next to 'server' and 'plugin').");
      finalBox(silent, std::wstring(L"Missing file: ") + need + L"\n\nPut this exe in the ROOT of the Photoshop Supreme MCP folder (next to 'server' and 'plugin') and run it again.", MB_ICONERROR);
      return 1;
    }
  }
  ok(L"Package files found in " + payloadDir.wstring());

  step(L"Stopping previous version");
  if (killProcessesNamed(kInstalledExe, GetCurrentProcessId())) {
    ok(L"Stopped running daemon.");
    Sleep(800);
  } else {
    ok(L"Nothing running.");
  }

  step(L"Detecting Photoshop");
  auto ps = findPhotoshop();
  if (ps.empty()) {
    warn(L"No Photoshop installation detected. Install Photoshop 2023 (24.2) or newer.");
  } else {
    for (auto& p : ps) ok(p.label + L"  ->  " + p.exe.wstring());
  }
  bool psRunning = processRunning(L"Photoshop.exe");

  step(L"Node.js runtime");
  std::optional<fs::path> node = findNode(installDir);
  if (node) {
    ok(L"Using " + node->wstring());
  } else {
    info(L"No Node.js >= " + std::to_wstring(kMinNodeMajor) + L" found - installing a private copy.");
    node = installPortableNode(installDir);
    if (!node) {
      warn(L"Node.js is required and could not be installed (no internet?).");
      finalBox(silent, L"Node.js could not be installed (no internet?).\n\nInstall Node.js from https://nodejs.org and run this again.\n\nLog: " + g_logPath, MB_ICONERROR);
      return 1;
    }
    ok(L"Installed " + node->wstring());
  }

  step(L"Removing old version");
  if (fs::exists(helperScript(installDir), ec)) removeOldPlugin(*node, installDir);  // old plugin first (uses previous helper if present)
  for (const wchar_t* item : {L"server", L"plugin"}) fs::remove_all(installDir / item, ec);
  fs::remove(installDir / L"plugin.ccx", ec);
  ok(L"Old files removed.");

  step(L"Installing new version");
  fs::path self = selfPath();
  for (const wchar_t* item : {L"server", L"plugin"}) {
    fs::copy(payloadDir / item, installDir / item, fs::copy_options::recursive | fs::copy_options::overwrite_existing, ec);
    if (ec) {
      warn(std::wstring(L"Copy failed for ") + item + L": " + fromUtf8(ec.message()));
      finalBox(silent, L"Copying files failed. See log:\n" + g_logPath, MB_ICONERROR);
      return 1;
    }
  }
  fs::copy_file(payloadDir / L"plugin.ccx", installDir / L"plugin.ccx", fs::copy_options::overwrite_existing, ec);
  if (!(fs::exists(installDir / kInstalledExe, ec) && fs::equivalent(self, installDir / kInstalledExe, ec))) {
    fs::copy_file(self, installDir / kInstalledExe, fs::copy_options::overwrite_existing, ec);
    if (ec) {
      warn(L"Could not copy launcher: " + fromUtf8(ec.message()));
      finalBox(silent, L"Could not copy the launcher. See log:\n" + g_logPath, MB_ICONERROR);
      return 1;
    }
  }
  writeFile(installDir / L"node-path.txt", toUtf8(node->wstring()));
  ok(L"Installed to " + installDir.wstring());

  step(L"Connecting AI apps (Claude Desktop, Cursor)");
  if (!configureHosts(installDir, *node)) warn(L"Could not update AI app configs.");

  step(L"Photoshop plugin");
  removeOldPlugin(*node, installDir);  // belt and braces: guarantees a clean slate for the new copy
  bool pluginOk = false;
  if (useCC) pluginOk = installPluginViaCC(installDir, ps) || installPluginDirect(*node, installDir);
  else pluginOk = installPluginDirect(*node, installDir) || installPluginViaCC(installDir, ps);

  step(L"Background daemon");
  bool daemonOk = registerAndStartDaemon(installDir);

  bool claudeRunning = processRunning(L"Claude.exe");
  bool cursorRunning = processRunning(L"Cursor.exe");
  bool allOk = pluginOk && daemonOk;

  std::wstring msg;
  if (allOk) msg = std::wstring(kAppName) + L" is installed and running.\n\nOpen Photoshop and your AI app - they connect automatically (no panel to open).";
  else msg = std::wstring(kAppName) + L" was installed with problems:\n";
  std::wstring restart;
  if (psRunning) restart += L"\n- Restart Photoshop (it loads plugins at startup).";
  if (claudeRunning) restart += L"\n- Restart Claude Desktop (it reads its config at startup).";
  if (cursorRunning) restart += L"\n- Restart Cursor.";
  if (!restart.empty()) msg += L"\n\nOne-time restarts needed:" + restart;
  if (!allOk) {
    for (auto& w : g_warns) msg += L"\n- " + w;
    msg += L"\n\nDetails: " + g_logPath;
  }
  say(msg);
  finalBox(silent, msg, allOk ? MB_ICONINFORMATION : MB_ICONWARNING);
  return allOk ? 0 : 2;
}

// ----------------------------------------------------------------------- main
int main() {
  initConsole();
  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  bool daemon = false, uninstall = false, silent = false, useCC = false, help = false;
  for (int i = 1; i < argc; i++) {
    std::wstring a = lower(argv[i]);
    if (a == L"--daemon") daemon = true;
    else if (a == L"--uninstall") uninstall = true;
    else if (a == L"--silent" || a == L"--no-pause") silent = true;
    else if (a == L"--use-cc") useCC = true;
    else if (a == L"--help" || a == L"-h" || a == L"/?") help = true;
  }
  if (argv) LocalFree(argv);

  if (daemon) return daemonMain();
  if (help) {
    emit(L"PhotoshopSupremeMCP-Setup.exe [--uninstall] [--silent] [--use-cc]");
    return 0;
  }
  return uninstall ? uninstallMain(silent) : installMain(selfPath().parent_path(), silent, useCC);
}
