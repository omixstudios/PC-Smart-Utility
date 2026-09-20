'use strict';
// PC Smart Utility v5.8.7 - main process
// v25: Dell Latitude/Vostro/Inspiron detection via BIOS registry (catches systems without
//      SupportAssist), low-RAM safe mode (<=6 GB RAM auto-triggers OEM protections),
//      slow-disk mode (HDD/<=8 GB RAM gets 1.25x WMI timeouts + extended Stage 4 delay),
//      What's New version key fixed (was 5.7.0, now tracks 6.x correctly),
//      window show fallback extended for slow systems.
//      getFolderSize sync shim confirmed unreachable from IPC paths
// v23: Final stabilization pass — all IPC file ops async, no sync I/O in hot paths,
//      interval stacking fix, GPU crash fallback corrected (no disable-gpu+swiftshader-webgl),
//      si.graphics removed from realtime poll (uses prewarm cache), monitoring pause/resume
//      wired into runAutoClean, missing await on resolveArcUserDataPath fixed,
//      loadSchedule/saveSchedule/loadPrefs/savePrefs in-memory cached + async flush,
//      battery report handlers fully async, all export file writes async.
// v22 base: Full async cleaner (no readdirSync/statSync), getFolderSizeAsync,
//      monitoring pause/resume IPC, GPU disableHardwareAcceleration fallback,
//      crash-persistent GPU safe mode, async Arc/profile discovery
// v20 base: sandbox:true, safeHandle queues, no wmic, full security


// ── OEM/Dell Safe Mode — detect BEFORE app.ready ─────────────────────────
// Dell SupportAssist, Alienware, and similar OEM services aggressively poll
// WMI on boot, causing our CIM queries to time out and Electron's GPU process
// to stall. We also detect HDD systems and low-RAM systems (<= 6 GB) and apply
// the same slow-system protections — they behave identically to OEM WMI issues.
//
// Detection strategy (runs SYNC before app.ready — intentionally):
//   1. Dell SupportAssist / Alienware folder presence (Dell with bloatware)
//   2. ComputerHardwareIds registry key for "Dell" manufacturer string
//      (catches Dell Latitude/Vostro/Inspiron that lack SupportAssist)
//   3. Total RAM <= 6 GB  — low-RAM systems are always I/O constrained
//   4. OS drive is HDD — detected via disk rotational speed hint in registry
//      (HKLM\...\Enum: not reliable; we use total RAM as HDD proxy since
//       systeminformation is not available pre-ready)
// ── UNIVERSAL HARDWARE COMPATIBILITY SYSTEM ──────────────────────────────
// Strategy: ALL systems run in safe mode by default.
// Only high-end confirmed-fast systems get full-speed mode.
// This ensures every brand (HP, Dell, Asus, Acer, Lenovo, Samsung, MSI,
// Toshiba, Sony, Fujitsu, custom builds), every RAM size (4GB–128GB),
// every disk type (HDD/SSD/NVMe/eMMC), every Windows version works perfectly.

// Hardware speed tier: 0=slow, 1=medium, 2=fast
// Default is SLOW (tier 0) — upgraded only if hardware proves fast
const _HW_TIER = (() => {
  try {
    const _os = require('os');
    const _cp = require('child_process');

    const ramGB = _os.totalmem() / (1024 * 1024 * 1024);

    // Any system with <=8 GB RAM → always slow tier
    if (ramGB <= 8) return 0;

    // Try to detect CPU speed via registry (fast, sync, no WMI needed)
    let cpuMHz = 0;
    try {
      const cpuReg = _cp.execSync(
        'reg query "HKLM\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0" /v ~MHz',
        { timeout: 1000, encoding: 'utf8', windowsHide: true }
      );
      const m = cpuReg.match(/0x([0-9a-f]+)/i);
      if (m) cpuMHz = parseInt(m[1], 16);
    } catch (_) {}

    // Slow CPU (< 2.0 GHz) → slow tier regardless of RAM
    if (cpuMHz > 0 && cpuMHz < 2000) return 0;

    // Check for ANY OEM background service bloat (all major brands)
    try {
      const mfr = _cp.execSync(
        'reg query "HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS" /v SystemManufacturer',
        { timeout: 1200, encoding: 'utf8', windowsHide: true }
      );
      // Every OEM has background WMI-polling services — all get medium tier minimum
      // Dell: SupportAssist | HP: Support Assistant + Wolf Security
      // Lenovo: Vantage | Asus: Armoury Crate | Acer: Care Center
      // Samsung: Settings | MSI: Dragon Center | Toshiba: Service Station
      const isOEM = /dell|hewlett|hp inc|hpe|lenovo|asus|acer|samsung|msi|toshiba|sony|fujitsu|gigabyte|huawei|microsoft surface/i.test(mfr);
      if (isOEM) {
        // OEM with high RAM (>16 GB) and fast CPU → medium tier
        if (ramGB > 16 && cpuMHz >= 2500) return 1;
        // OEM with 8–16 GB RAM → slow tier
        return 0;
      }
    } catch (_) {}

    // Custom/no-OEM build: RAM>16GB + fast CPU → fast tier
    if (ramGB > 16 && cpuMHz >= 3000) return 2;
    // RAM>16GB but unknown CPU speed → medium tier
    if (ramGB > 16) return 1;

    // Default fallback → slow tier (safe for everything)
    return 0;
  } catch (_) { return 0; } // any error → safest tier
})();

// Legacy flags — kept for code compatibility throughout main.js
const _OEM_SAFE_MODE = _HW_TIER === 0;  // slow tier = safe mode ON
const _IS_SLOW_DISK  = _HW_TIER <= 1;   // slow+medium = extended timeouts

// Startup delay: slow=1500ms | medium=600ms | fast=0ms
const _OEM_DELAY_MS = _HW_TIER === 0 ? 1500 : _HW_TIER === 1 ? 600 : 0;
// Flag: is cleaner currently running? Pause realtime monitoring during scans
let _cleanerRunning = false;

// ── GPU Crash Persistence — survive across restarts ──────────────────────
// If GPU crashed 3+ times, disable hardware acceleration entirely on next launch.
// File-based so it persists across app restarts (in-memory flag does not survive reload).
const _GPU_CRASH_FILE = require('path').join(require('os').homedir(), 'pc-smart-gpu-crashes.json');
let _gpuCrashPersistCount = 0;
try {
  const _raw = require('fs').readFileSync(_GPU_CRASH_FILE, 'utf8');
  const _parsed = JSON.parse(_raw);
  _gpuCrashPersistCount = _parsed.count || 0;
  // Auto-reset after 24h (driver update, reboot may fix it)
  if (_parsed.ts && Date.now() - _parsed.ts > 86400000) { _gpuCrashPersistCount = 0; }
} catch (_) {}
// If 3+ historical crashes: disable hardware acceleration before anything
if (_gpuCrashPersistCount >= 3) {
  try { require('electron').app.disableHardwareAcceleration(); } catch (_) {}
}

// ── Global crash guards (prevent silent crashes on any system) ───────────
process.on('uncaughtException', (err) => {
  try {
    const fs2 = require('fs'); const path2 = require('path');
    const logPath = path2.join(require('os').homedir(), 'pc-smart-crash.log');
    fs2.appendFileSync(logPath, `[${new Date().toISOString()}] UncaughtException: ${err?.stack || err?.message || err}\n`);
  } catch (_) {}
});
process.on('unhandledRejection', (reason) => {
  try {
    const fs2 = require('fs'); const path2 = require('path');
    const logPath = path2.join(require('os').homedir(), 'pc-smart-crash.log');
    fs2.appendFileSync(logPath, `[${new Date().toISOString()}] UnhandledRejection: ${reason?.stack || reason?.message || reason}\n`);
  } catch (_) {}
});

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, clipboard, nativeTheme, protocol, Notification, powerMonitor } = require('electron');

// Required for Windows toast notifications to actually display. Without this,
// Electron's Notification API can silently fail to show anything on Windows —
// independent of whether the trigger (Task Scheduler / in-app timer) ran correctly.
// Must match the Package Identity Name used in Partner Center / package.json appId.
try { app.setAppUserModelId('OmixStudios.PCSmartUtility'); } catch (_) {}
const { registerAppProtocol, registerDeepLinkProtocol } = require('./protocol');
const path = require('path');
const { exec, spawn } = require('child_process');
const si = require('systeminformation');
const os = require('os');
const fs = require('fs');
const https = require('https');

nativeTheme.themeSource = 'dark';

// ── FIX-3: CPU load via os.cpus() delta — zero WMI, works on all OEM ────────
// Replaces si.currentLoad() which calls Win32_PerfFormattedData via WMI
// and stalls on Dell/HP/Lenovo with OEM telemetry apps running.
let _lastCpuTick = null;
function getCpuLoadFast() {
  const cpus = os.cpus();
  const now = cpus.map(c => ({
    idle:  c.times.idle,
    total: Object.values(c.times).reduce((a, b) => a + b, 0)
  }));
  if (!_lastCpuTick || _lastCpuTick.length !== now.length) {
    _lastCpuTick = now;
    return { currentLoad: 0, cpus: cpus.map(() => ({ load: 0 })) };
  }
  const loads = now.map((c, i) => {
    const dIdle  = c.idle  - _lastCpuTick[i].idle;
    const dTotal = c.total - _lastCpuTick[i].total;
    const load   = dTotal === 0 ? 0 : +((1 - dIdle / dTotal) * 100).toFixed(1);
    return { load: Math.max(0, Math.min(100, load)) };
  });
  _lastCpuTick = now;
  const avg = loads.reduce((a, b) => a + b.load, 0) / loads.length;
  return { currentLoad: +avg.toFixed(1), cpus: loads };
}
// ─────────────────────────────────────────────────────────────────────────────

// ── FIX-4: Cache si.fsSize() — 30s TTL, prevents disk thrash every 5s ───────
// si.fsSize() enumerates all mounted volumes. On HDD laptops this spins the disk
// and triggers antivirus on every poll. Drive sizes don't change meaningfully
// in 30 seconds — caching is safe and imperceptible to users.
let _fsSizeCache = { data: [], ts: 0 };
async function getFsSizeCached() {
  if (Date.now() - _fsSizeCache.ts < 30000 && _fsSizeCache.data.length > 0) {
    return _fsSizeCache.data; // return cached — still fresh
  }
  try {
    const result = await Promise.race([
      si.fsSize(),
      new Promise(res => setTimeout(() => res([]), 5000))
    ]);
    _fsSizeCache = { data: result || [], ts: Date.now() };
    return _fsSizeCache.data;
  } catch (_) {
    return _fsSizeCache.data; // return stale on error — better than nothing
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── FIX-5: Battery state via Electron powerMonitor — zero WMI ────────────────
// Old: Win32_Battery + BatteryStatus WMI polled every 30s → stalls on Dell/HP/Lenovo
// New: powerMonitor events update ac/charging state instantly, si.battery() for
//      percent only (max once per 60s). No more OEM battery service deadlocks.
let _battPMCache = {
  hasBattery: false, percent: 0,
  isCharging: false, acConnected: true,
  voltage: null, maxCapacity: null, designedCapacity: null,
  ts: 0
};
// powerMonitor events fire when charger plugged/unplugged — instant, no polling
app.whenReady().then(() => {
  try {
    powerMonitor.on('on-ac',      () => { _battPMCache.acConnected = true;  _battPMCache.isCharging = true;  });
    powerMonitor.on('on-battery', () => { _battPMCache.acConnected = false; _battPMCache.isCharging = false; });
  } catch (_) {} // powerMonitor not available on desktop-only systems
});
// ─────────────────────────────────────────────────────────────────────────────

// ── BIOS date formatter — handles raw WMI strings & ISO dates ─────────────
function formatBiosDate(raw) {
  if (!raw) return null;
  try {
    const wmi = String(raw).trim().match(/^(\d{4})(\d{2})(\d{2})/);
    if (wmi) {
      const d = new Date(`${wmi[1]}-${wmi[2]}-${wmi[3]}`);
      if (!isNaN(d)) return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    }
    const d = new Date(raw);
    if (!isNaN(d)) return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch (_) {}
  return String(raw).trim() || null;
}

// ── safeHandle - serialised per-channel queue ──────────────────────────────
const _ipcChains  = {};
const _ipcPending = {};
function safeHandle(channel, handler) {
  _ipcChains[channel]  = Promise.resolve();
  _ipcPending[channel] = 0;
  ipcMain.handle(channel, (event, ...args) => {
    // OEM/slow systems: reduce max pending to prevent WMI queue buildup
    const _maxPending = _HW_TIER === 2 ? 3 : 2; // slow/medium: 2 max | fast: 3 max
    if (_ipcPending[channel] >= _maxPending) {
      return Promise.resolve({ ok: false, error: 'Too many pending requests - please wait.' });
    }
    _ipcPending[channel]++;
    const p = _ipcChains[channel]
      .then(() => handler(event, ...args))
      .catch(e => ({ ok: false, error: e.message }))
      .finally(() => {
        _ipcPending[channel] = Math.max(0, _ipcPending[channel] - 1);
        if (_ipcPending[channel] === 0) _ipcChains[channel] = Promise.resolve();
      });
    _ipcChains[channel] = p.catch(() => {});
    return p;
  });
}

let mainWindow = null;
let tray = null;
let _pendingSection = null; // section to navigate to after app relaunches from notification

// ── Silent launch handlers (Task Scheduler notifications) ────────────────────
function _handleNotifyArgs(argv) {
  // Quiz reminder
  if (argv.includes('--quiz-notify')) {
    app.whenReady().then(() => {
      setTimeout(() => {
        try {
          // Dedup: if in-process timer already fired today, skip
          const todayKey = new Date().toISOString().slice(0, 10);
          if (_quizLastFiredDay === todayKey) return;
          _saveQuizLastFiredDay(todayKey);
          if (!Notification.isSupported()) return;
          const n = new Notification({
            title: '🧠 Show Off Your Knowledge!',
            body: "Today's quiz is ready — keep your streak alive!",
            silent: false,
          });
          n.show();
          n.on('click', () => { _notifNavigate('cybersecurity'); });
        } catch(_) {}
      }, 1500);
    });
  }
  // Auto-clean reminder
  if (argv.includes('--clean-notify')) {
    app.whenReady().then(() => {
      setTimeout(() => {
        try {
          const todayKey = new Date().toISOString().slice(0, 10);
          if (_cleanLastFiredDay === todayKey) return; // already fired today
          _saveCleanLastFiredDay(todayKey);
          if (!Notification.isSupported()) return;
          const n = new Notification({
            title: '🚀 Boost Your PC Performance',
            body: 'Clear temp & cache files now for a faster, smoother PC.',
            silent: false,
          });
          n.show();
          n.on('click', () => {
            _notifNavigate('cleaner');
            const w2 = BrowserWindow.getAllWindows()[0] || null;
            if (w2 && !w2.isDestroyed()) {
              const navDelay = _HW_TIER === 0 ? 1600 : _HW_TIER === 1 ? 1100 : 800;
              setTimeout(() => {
                if (w2 && !w2.isDestroyed()) w2.webContents.send('auto-clean-prompt');
              }, navDelay);
            }
          });
        } catch(_) {}
      }, 1500);
    });
  }
}

if (process.argv.includes('--quiz-notify') || process.argv.includes('--clean-notify')) {
  _handleNotifyArgs(process.argv);
}

// ── Unified cache ─────────────────────────────────────────────────────────
const CACHE = {
  sysInfo:    { data: null, ts: 0, ttl: 2  * 60 * 1000 },
  diskLayout: { data: null, ts: 0, ttl: 10 * 60 * 1000 },
  graphics:   { data: null, ts: 0, ttl: 10 * 60 * 1000 },
  netIfaces:  { data: null, ts: 0, ttl: 5  * 60 * 1000 },
  battery:    { data: null, ts: 0, ttl: 30 * 1000 },
};

// FIX-6: remember the last known-good battery reading. If a fresh WMI
// battery query times out (common on Dell/HP/Lenovo), we fall back to this
// instead of reporting "no battery" — fixes battery data being inconsistent
// in the System Report.
let _lastGoodBattery = null;

const _inflight = {};

function cacheGet(key) {
  const c = CACHE[key];
  if (c.data && (Date.now() - c.ts) < c.ttl) return c.data;
  return null;
}
function cacheSet(key, data) {
  CACHE[key].data = data;
  CACHE[key].ts   = Date.now();
}

const siTout = (p, ms = 10000) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('si timeout')), ms))]);

async function fetchOnce(key, fn) {
  const cached = cacheGet(key);
  if (cached) return cached;
  if (_inflight[key]) return _inflight[key];
  _inflight[key] = siSafe(fn())
    .then(d => { if (d != null) cacheSet(key, d); delete _inflight[key]; return d; })
    .catch(e  => { delete _inflight[key]; throw e; });
  return _inflight[key];
}

// CMD Whitelist - ALL PowerShell CIM, no deprecated wmic
const CMD_WHITELIST = {
  'systeminfo':    'systeminfo',
  'netstat':       'netstat -ano',
  'arp':           'arp -a',
  'route':         'route print',
  'ipconfig':      'ipconfig /all',
  'net-user':      'net user',
  'wmic-cpu':      'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,Manufacturer,Caption | Format-List"',
  'wmic-ram':      'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_PhysicalMemory | Select-Object Capacity,Speed,Manufacturer,FormFactor,BankLabel,PartNumber | Format-List"',
  'wmic-disk':     'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_DiskDrive | Select-Object Model,Size,InterfaceType,Status,SerialNumber,FirmwareRevision | Format-List"',
  'wmic-bios':     'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_BIOS | Select-Object Manufacturer,SMBIOSBIOSVersion,ReleaseDate,SerialNumber | Format-List"',
  'wmic-nic':      'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_NetworkAdapter | Where-Object {$_.PhysicalAdapter} | Select-Object Name,MACAddress,Speed,NetConnectionStatus,Manufacturer | Format-List"',
  'ps-adapters':   'powershell -NoProfile -NonInteractive -Command "Get-NetAdapter | Format-Table Name,Status,LinkSpeed,MacAddress -AutoSize"',
  'ps-ip':         'powershell -NoProfile -NonInteractive -Command "Get-NetIPAddress | Format-Table InterfaceAlias,AddressFamily,IPAddress,PrefixLength -AutoSize"',
  'ps-dns':        'powershell -NoProfile -NonInteractive -Command "Get-DnsClientServerAddress | Where-Object {$_.ServerAddresses} | Format-Table InterfaceAlias,ServerAddresses -AutoSize"',
  'wifi-info':     'netsh wlan show interfaces',
  'wifi-detail':   'netsh wlan show interfaces',
  'wifi-profiles': 'netsh wlan show profiles',
  'ps-processes':  'powershell -NoProfile -NonInteractive -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First 20 Name,CPU,WorkingSet | Format-Table -AutoSize"',
  'ps-services':   'powershell -NoProfile -NonInteractive -Command "Get-Service | Where-Object {$_.Status -eq \'Running\'} | Select-Object Name,DisplayName | Format-Table -AutoSize"',
  'ps-events':     'wevtutil qe System /q:"*[System[Level=2]]" /c:15 /rd:true /f:text',
  'drivers':       'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_PnPSignedDriver | Where-Object {$_.DeviceName} | Select-Object DeviceName,DriverVersion,Manufacturer | Sort-Object DeviceName | Format-Table -AutoSize"',
  'shares':        'net share',
  'users':         'net localgroup administrators',
  'firewall':      'netsh advfirewall show allprofiles state',
  'uptime':        'powershell -NoProfile -NonInteractive -Command "(Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime | Select-Object Days,Hours,Minutes | Format-Table -AutoSize"',
  'net-connections':'powershell -NoProfile -NonInteractive -Command "Get-NetTCPConnection | Where-Object {$_.State -eq \'Established\'} | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State | Format-Table -AutoSize"',
  'net-routes':    'powershell -NoProfile -NonInteractive -Command "Get-NetRoute | Where-Object {$_.DestinationPrefix -ne \'0.0.0.0/0\'} | Select-Object DestinationPrefix,NextHop,InterfaceAlias,RouteMetric | Format-Table -AutoSize"',
  'net-shares':    'powershell -NoProfile -NonInteractive -Command "Get-SmbShare | Format-Table Name,Path,Description -AutoSize"',
  'net-stats':     'powershell -NoProfile -NonInteractive -Command "Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes | Format-Table -AutoSize"',
  'defrag-status': 'powershell -NoProfile -NonInteractive -Command "Get-Volume | Where-Object {$_.DriveLetter} | Select-Object DriveLetter,FileSystemLabel,Size,SizeRemaining,HealthStatus,DriveType | Format-Table -AutoSize"',
};


// ── Safe URL validator — hardens quick-links against malicious injection ──
const SAFE_URL_PATTERN = /^(https?:\/\/[a-zA-Z0-9._~:/?#\[\]@!$&'()*+,;=%\-]+|ms-settings:[a-z\-]+)$/;
const BLOCKED_URL_HOSTS = new Set(['localhost','127.0.0.1','0.0.0.0','::1']);
function isSafeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!SAFE_URL_PATTERN.test(trimmed)) return false;
  try {
    if (trimmed.startsWith('http')) {
      const u = new URL(trimmed);
      if (BLOCKED_URL_HOSTS.has(u.hostname)) return false;
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    }
  } catch(_) { return false; }
  return true;
}

const ALLOWED_MS_SETTINGS = new Set([
  'ms-settings:display','ms-settings:nightlight','ms-settings:network-airplanemode',
  'ms-settings:appsfeatures','ms-settings:windowsdefender','ms-settings:windowsupdate',
  'ms-settings:storagesense','ms-settings:troubleshoot','ms-settings:printers',
  'ms-settings:startupapps','ms-settings:bluetooth','ms-settings:privacy',
  'ms-settings:personalization','ms-settings:sound','ms-settings:power-sleep',
  'ms-settings:batterysaver','ms-settings:battery','ms-settings:otherusers',
  'ms-settings:network-status','ms-settings:datausage',
  'ms-settings:','ms-settings:yourinfo','ms-settings:powersleep',
]);

const ALLOWED_TOOLS = {
  taskmgr:      'taskmgr.exe',
  calc:         'calc.exe',
  notepad:      'notepad.exe',
  osk:          'osk.exe',
  snippingtool: 'snippingtool.exe',
  mstsc:        'mstsc.exe',
  devmgmt:      'devmgmt.msc',
  diskmgmt:     'diskmgmt.msc',
  eventvwr:     'eventvwr.exe',
  resmon:       'resmon.exe',
  perfmon:      'perfmon.exe',
  dfrgui:       'dfrgui.exe',
  credwiz:      'credwiz.exe',
  control:      'control.exe',
  powercfg:     'powercfg.cpl',
  cmd:          'cmd.exe',
  powershell:   'powershell.exe',
};

function safeExec(cmd, opts = {}) {
  return new Promise((resolve) => {
    try {
      exec(cmd, { timeout: 10000, maxBuffer: 1024 * 1024 * 4, ...opts }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: (stdout || '').trim(), err: (err?.message || stderr || '').trim() });
      });
    } catch (e) { resolve({ ok: false, out: '', err: e.message }); }
  });
}

function openTool(key) {
  const exe = ALLOWED_TOOLS[key];
  if (!exe) return;
  if (exe.endsWith('.msc')) {
    spawn('cmd.exe', ['/c', 'start', '', exe], { detached: true, stdio: 'ignore' }).unref();
  } else {
    shell.openPath(exe).catch(() => {
      spawn('cmd.exe', ['/c', 'start', '', exe], { detached: true, stdio: 'ignore' }).unref();
    });
  }
}

function openSettings(uri) {
  if (ALLOWED_MS_SETTINGS.has(uri)) shell.openExternal(uri).catch(() => {});
}

// getFolderSizeAsync — fully async chunked, never blocks event loop
// Uses fs.promises throughout — no readdirSync/statSync anywhere
// maxItems: caps on huge temp folders (Dell OEM: 50k+ files)
// CHUNK_YIELD: yields every N dirs so renderer stays responsive
async function getFolderSizeAsync(folderPath, maxItems = 5000) {
  const CHUNK_YIELD = 50;
  let size = 0;
  const deadline = Date.now() + (_HW_TIER === 0 ? 3000 : _HW_TIER === 1 ? 2500 : 2000);
  try {
    const accessible = await fs.promises.access(folderPath).then(() => true).catch(() => false);
    if (!accessible) return 0;
    const stack = [folderPath];
    let count = 0, dirCount = 0;
    while (stack.length > 0 && Date.now() < deadline && count < maxItems) {
      const dir = stack.pop();
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
      dirCount++;
      if (dirCount % CHUNK_YIELD === 0) await new Promise(r => setImmediate(r));
      for (const entry of entries) {
        if (Date.now() >= deadline || count >= maxItems) break;
        count++;
        try {
          const full = path.join(dir, entry.name);
          if (entry.isFile()) {
            const s = await fs.promises.stat(full).catch(() => null);
            if (s) size += s.size;
          } else if (entry.isDirectory()) {
            stack.push(full);
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
  return size;
}
// Sizes ONLY thumbcache_*.db files — matches exactly what clean-thumbcache deletes,
// so the size shown to the user reflects what will actually be removed.
async function getThumbcacheFilesSizeAsync(folderPath) {
  let size = 0;
  try {
    const accessible = await fs.promises.access(folderPath).then(() => true).catch(() => false);
    if (!accessible) return 0;
    const entries = await fs.promises.readdir(folderPath).catch(() => []);
    for (const name of entries) {
      if (!(name.startsWith('thumbcache_') && name.endsWith('.db'))) continue;
      const s = await fs.promises.stat(path.join(folderPath, name)).catch(() => null);
      if (s) size += s.size;
    }
  } catch (_) {}
  return size;
}
// Sync shim retained ONLY for OEM detection at startup (before app.ready)
// All cleaner/estimate calls use getFolderSizeAsync instead
function getFolderSize(folderPath, maxItems = 500) {
  // Intentionally limited: only used for small dirs (thumbcache/recent)
  // Real scanning always goes through getFolderSizeAsync
  let size = 0;
  const deadline = Date.now() + 500;
  try {
    if (!require('fs').existsSync(folderPath)) return 0;
    const stack = [folderPath];
    let count = 0;
    while (stack.length > 0 && Date.now() < deadline && count < maxItems) {
      const dir = stack.pop();
      let entries;
      try { entries = require('fs').readdirSync(dir); } catch (_) { continue; }
      for (const entry of entries) {
        if (count++ >= maxItems || Date.now() >= deadline) break;
        try {
          const full = path.join(dir, entry);
          const s = require('fs').statSync(full);
          if (s.isFile()) size += s.size;
          else if (s.isDirectory()) stack.push(full);
        } catch (_) {}
      }
    }
  } catch (_) {}
  return size;
}

// Async chunked file deletion — yields to event loop every CHUNK_SIZE items
// Prevents main process blocking on large temp folders (Dell OEM: 10k+ files)
// Fully async: no readdirSync/statSync/rmSync — never blocks renderer
async function deleteFilesChunked(dirPath, filterFn = null, chunkSize = 50) {
  let removed = 0;
  try {
    const accessible = await fs.promises.access(dirPath).then(() => true).catch(() => false);
    if (!accessible) return removed;
    const items = await fs.promises.readdir(dirPath).catch(() => []);
    for (let i = 0; i < items.length; i += chunkSize) {
      const chunk = items.slice(i, i + chunkSize);
      for (const item of chunk) {
        if (filterFn && !filterFn(item)) continue;
        try { await fs.promises.rm(path.join(dirPath, item), { recursive: true, force: true }); removed++; }
        catch (_) {}
      }
      if (i + chunkSize < items.length) await new Promise(r => setImmediate(r));
    }
  } catch (_) {}
  return removed;
}

// ── Pre-warm functions ────────────────────────────────────────────────────
// siSafe: individual call timeout — never throws, never blocks siblings
// Tier 0 (slow/OEM): 2x timeout | Tier 1 (medium): 1.5x | Tier 2 (fast): 1x
// Minimum floor of 15000ms on slow tier so no system ever hard-times-out
function siSafe(p, ms) {
  const base = ms || 8000;
  const budget = _HW_TIER === 0
    ? Math.max(15000, Math.round(base * 2))
    : _HW_TIER === 1
      ? Math.round(base * 1.5)
      : base;
  return Promise.race([
    p,
    new Promise(r => setTimeout(() => r(null), budget))
  ]).catch(() => null);
}

async function prewarmSysInfo() {
  // WMI crash protection: if si calls hang beyond their timeout, return cached/empty
  // rather than blocking. OEM systems have unreliable WMI on first boot.
  return fetchOnce('sysInfo', async () => {
    // Each call has its OWN timeout — one slow OEM call never blocks the rest
    const [system, osInfo, bios, cpu, memLayout] = await Promise.all([
      siSafe(si.system(),    7000),
      siSafe(si.osInfo(),    6000),
      siSafe(si.bios(),      6000),
      siSafe(si.cpu(),       6000),
      siSafe(si.memLayout(), 8000),
    ]);

    let installDate = null, systemAge = null;
    safeExec(
      `powershell -NoProfile -NonInteractive -Command "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').InstallDate"`,
      { timeout: 4000 }
    ).then(r => {
      const ts = parseInt(r.out);
      if (!isNaN(ts) && ts > 0) {
        const d = new Date(ts * 1000);
        installDate = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        const days = Math.floor((Date.now() - d) / 86400000);
        const years = Math.floor(days / 365);
        const months = Math.floor((days % 365) / 30);
        systemAge = years > 0 ? `${years}y ${months}m` : `${months}m`;
        const cached = cacheGet('sysInfo');
        if (cached) { cached.installDate = installDate; cached.systemAge = systemAge; }
      }
    }).catch(() => {});

    const uptimeSec = os.uptime();
    const uptime = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;

    const ramModules = (memLayout || []).filter(m => m && m.size > 0).map(m => ({
      size:         (m.size / 1073741824).toFixed(0) + ' GB',
      type:         m.type         || 'Unknown',
      speed:        m.clockSpeed   ? m.clockSpeed + ' MHz' : null,
      manufacturer: m.manufacturer || null,
      bank:         m.bank         || null,
    }));

    const cpuDetails = cpu ? {
      brand:         cpu.brand || `${cpu.manufacturer || ''} ${cpu.model || ''}`.trim() || null,
      cores:         cpu.cores         || null,
      physicalCores: cpu.physicalCores || null,
      speed:         cpu.speed         || null,
      speedMin:      cpu.speedMin      || null,
      speedMax:      cpu.speedMax      || null,
      cache:         cpu.cache         || null,
      socket:        cpu.socket        || null,
      flags:         cpu.flags         || null,
    } : null;

    // Run all 3 serial sources IN PARALLEL — pick first valid one (much faster)
    const siSerial = (system && system.serial && system.serial !== 'Default string' && system.serial.trim().length > 3)
      ? system.serial.trim() : null;
    const [biosSerialRes, csSerialRes] = await Promise.all([
      siSerial ? Promise.resolve(null) : safeExec(
        'powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_BIOS -EA SilentlyContinue).SerialNumber"',
        { timeout: 4000 }
      ).catch(() => null),
      siSerial ? Promise.resolve(null) : safeExec(
        'powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_ComputerSystemProduct -EA SilentlyContinue).IdentifyingNumber"',
        { timeout: 4000 }
      ).catch(() => null),
    ]);
    function isValidSerial(s) {
      if (!s || s.length < 3) return false;
      const bad = ['default string','to be filled by o.e.m.','none','n/a','','0'];
      return !bad.includes(s.toLowerCase().trim());
    }
    const biosS = (biosSerialRes?.out || '').trim();
    const csS   = (csSerialRes?.out   || '').trim();
    const resolvedSerial = isValidSerial(siSerial) ? siSerial
      : isValidSerial(biosS) ? biosS
      : isValidSerial(csS)   ? csS
      : null;

    return {
      ok: true,
      manufacturer: system?.manufacturer || null,
      model:        system?.model        || null,
      serial:       resolvedSerial,
      os:           osInfo ? `${osInfo.distro} ${osInfo.release}` : null,
      osArch:       osInfo?.arch   || null,
      osBuild:      osInfo?.build  || null,
      installDate,  systemAge, uptime,
      bios: bios ? { vendor: bios.vendor || null, version: bios.version || null, date: formatBiosDate(bios.releaseDate) } : null,
      cpu:  cpuDetails,
      ramModules,
      _raw: { system, osInfo, bios, cpu, memLayout },
    };
  });
}

async function prewarmDisk() {
  return fetchOnce('diskLayout', async () => {
    const disks = await siSafe(si.diskLayout(), 10000) || [];
    return {
      ok: true,
      disks: disks.map(d => ({
        name: d.name, type: d.type || 'Unknown',
        size: +(d.size / 1073741824).toFixed(1),
        vendor: d.vendor || null, model: d.model || null,
        interfaceType: d.interfaceType || null,
        serial: d.serialNum && d.serialNum.length > 3 ? d.serialNum : null,
        firmware: d.firmwareRevision || null, smartStatus: d.smartStatus || null,
      })),
      _rawDisks: disks,
    };
  });
}

async function prewarmGraphics() {
  return fetchOnce('graphics', async () => {
    const g = await siSafe(si.graphics(), 10000);
    if (!g) return { ok: true, controllers: [], displays: [] };
    return {
      ok: true,
      controllers: (g.controllers || []).map(c => ({
        model:         c.model           || 'Unknown GPU',
        vendor:        c.vendor          || null,
        vram:          c.vram            || null,
        driverVersion: c.driverVersion   || null,
        resolutionX:   c.resolutionX     || null,
        resolutionY:   c.resolutionY     || null,
        refreshRate:   c.currentRefreshRate || null,
      })),
      displays: (g.displays || []).map(d => ({
        model:       d.model             || 'Display',
        resolutionX: d.resolutionX       || null,
        resolutionY: d.resolutionY       || null,
        refreshRate: d.currentRefreshRate || null,
        pixelDepth:  d.pixelDepth        || null,
      })),
      _rawControllers: g.controllers || [],
    };
  });
}

async function prewarmNetIfaces() {
  return fetchOnce('netIfaces', async () => {
    const ifaces = await siSafe(si.networkInterfaces());
    return { ok: true, ifaces: Array.isArray(ifaces) ? ifaces : [] };
  });
}

async function prewarmBattery() {
  return fetchOnce('battery', async () => {
    // FIX-6: 12s budget (was default 8s) — WMI battery queries can be slow.
    const bat = await siSafe(si.battery(), 12000);
    if (bat && bat.hasBattery) _lastGoodBattery = bat; // remember last known-good reading
    return bat;
  });
}

const STORE_URL = 'ms-windows-store://pdp/?ProductId=9NW5DMR2XQ36';

// ── _notifNavigate — bring app to front and navigate to a section ─────────────
// Called when user clicks a toast notification (quiz or cleaner).
// If window already exists: show + focus + send navigate IPC.
// If window not ready yet (silent launch): set _pendingSection — createWindow picks it up.
function _notifNavigate(section) {
  try {
    const w = BrowserWindow.getAllWindows()[0] || mainWindow;
    if (w && !w.isDestroyed()) {
      if (w.isMinimized()) w.restore();
      w.show(); w.focus();
      const navDelay = _HW_TIER === 0 ? 1800 : _HW_TIER === 1 ? 1200 : 800;
      setTimeout(() => {
        if (w && !w.isDestroyed()) w.webContents.send('navigate-to-section', section);
      }, navDelay);
    } else {
      _pendingSection = section;
      // App not visible — show it
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show(); mainWindow.focus();
      }
    }
  } catch (_) {
    _pendingSection = section;
  }
}

// ── _psToastScript — builds a PowerShell WinRT toast notification script ─────
// Used by Task Scheduler to fire a notification even when app is fully closed.
// Clicking the toast launches the app via deep-link (pcsmartutility://<page>).
function _psToastScript(title, body, activationUrl) {
  // WinRT toast XML — works on Windows 10/11 without any external tools
  const toastXml = `<toast activationType="protocol" launch="${activationUrl}">
  <visual><binding template="ToastGeneric">
    <text>${title.replace(/"/g, '&quot;')}</text>
    <text>${body.replace(/"/g, '&quot;')}</text>
  </binding></visual>
  <actions>
    <action content="Open" activationType="protocol" arguments="${activationUrl}"/>
  </actions>
</toast>`.replace(/\n/g, '').replace(/\r/g, '');

  // PowerShell script to fire the toast using WinRT API
  return `
[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null;
[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom,ContentType=WindowsRuntime]|Out-Null;
$xml=New-Object Windows.Data.Xml.Dom.XmlDocument;
$xml.LoadXml('${toastXml.replace(/'/g, "''")}');
$toast=New-Object Windows.UI.Notifications.ToastNotification($xml);
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('PC Smart Utility').Show($toast);
`.trim();
}

// ── Task Scheduler diagnostics — writes real success/failure to disk so it can
// be inspected even though registration runs silently in the background. ────
const _TASK_LOG_FILE = path.join(app.getPath('userData'), 'task-scheduler-log.json');
function _logTaskResult(label, err, stdout, stderr) {
  try {
    const entry = {
      label,
      ts: new Date().toISOString(),
      ok: !err && !(stderr && stderr.trim()),
      error: err ? String(err.message || err) : null,
      stderr: (stderr || '').trim() || null,
      stdout: (stdout || '').trim() || null,
    };
    let log = [];
    try { log = JSON.parse(fs.readFileSync(_TASK_LOG_FILE, 'utf8')); } catch (_) {}
    log.unshift(entry);
    log = log.slice(0, 20); // keep last 20 entries
    fs.writeFileSync(_TASK_LOG_FILE, JSON.stringify(log, null, 2));
  } catch (_) {}
}

// IPC: lets the renderer show a "Notification Diagnostics" panel — run this,
// screenshot the result, and that tells us definitively whether registration
// is succeeding and whether Windows actually has the tasks.
safeHandle('notif-diagnostics', async () => {
  const result = { registrationLog: [], quizTaskExists: null, cleanTaskExists: null, raw: '' };
  try {
    result.registrationLog = JSON.parse(fs.readFileSync(_TASK_LOG_FILE, 'utf8'));
  } catch (_) {}
  await new Promise((resolve) => {
    exec(
      `powershell -NoProfile -NonInteractive -Command "Get-ScheduledTask -TaskName '${QUIZ_TASK_NAME}','${CLEAN_TASK_NAME}' -EA SilentlyContinue | Select-Object TaskName,State | ConvertTo-Json"`,
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        result.raw = (stdout || '').trim();
        result.quizTaskExists = result.raw.includes(QUIZ_TASK_NAME);
        result.cleanTaskExists = result.raw.includes(CLEAN_TASK_NAME);
        resolve();
      }
    );
  });
  return result;
});



function _registerCleanTask(s) {
  _unregisterCleanTask();
  if (!s || !s.enabled) return;
  // Login-triggered: fires when Windows logs the user in, works even when app
  // was fully closed. The in-app day-guard ensures it still only shows once/day.
  const exePath = app.getPath('exe').replace(/'/g, "''");
  const ps = [
    `$a = New-ScheduledTaskAction -Execute '${exePath}' -Argument '--clean-notify --silent';`,
    `$t1 = New-ScheduledTaskTrigger -AtLogOn;`,
    `$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 4) -RepetitionDuration ([TimeSpan]::MaxValue);`,
    `$t3 = $null; try { $t3 = New-ScheduledTaskTrigger -SessionStateChange -StateChange SessionUnlock } catch { $t3 = $null };`,
    `$triggers = if ($t3) { @($t1,$t2,$t3) } else { @($t1,$t2) };`,
    `$s2 = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew -StartWhenAvailable:$true;`,
    `$p = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited;`,
    `Register-ScheduledTask -TaskName '${CLEAN_TASK_NAME}' -Action $a -Trigger $triggers -Settings $s2 -Principal $p -Force -EA Stop | Out-Null;`,
    `Write-Output 'OK';`,
  ].join(' ');
  const psB64 = Buffer.from(ps, 'utf16le').toString('base64');
  exec(`powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${psB64}`,
    { windowsHide: true, timeout: 12000 }, (err, stdout, stderr) => {
      _logTaskResult('clean-register', err, stdout, stderr);
    });
}

function _unregisterCleanTask() {
  exec(`schtasks /Delete /F /TN "${CLEAN_TASK_NAME}"`, { windowsHide: true }, () => {});
}

// Persist clean-fired-day across restarts so we don't double-fire on same day after reboot
let _cleanLastFiredDay = null;
const _CLEAN_FIRED_FILE = path.join(app.getPath('userData'), 'clean-last-fired.json');
function _loadCleanLastFiredDay() {
  try {
    const raw = fs.readFileSync(_CLEAN_FIRED_FILE, 'utf8');
    const obj = JSON.parse(raw);
    _cleanLastFiredDay = obj.day || null;
  } catch(_) {}
}
function _saveCleanLastFiredDay(day) {
  _cleanLastFiredDay = day;
  fs.promises.writeFile(_CLEAN_FIRED_FILE, JSON.stringify({ day }), 'utf8').catch(() => {});
}
_loadCleanLastFiredDay();



// Module-level silent flag — set before createWindow() so all functions can check it
const _SILENT_LAUNCH = process.argv.includes('--silent');

function createWindow() {
  let iconPath = null;
  try { const p = path.join(__dirname, 'build', 'icon.ico'); if (fs.existsSync(p)) iconPath = p; } catch (_) {}

  // _SILENT_LAUNCH is now a module-level const (defined above createWindow)

  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 720,
    backgroundColor: '#07090f', title: 'PC Smart Utility',
    // Prevent black flash on slow/integrated GPUs (Dell, HP, Lenovo Intel iGPU)
    show: false,
    paintWhenInitiallyHidden: true,  // ensures GPU renders while hidden — eliminates black flash
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      devTools: false, spellcheck: false,
    },
    frame: true, autoHideMenuBar: true,
  });

  // CSP via webRequest (belt + suspenders with meta CSP in HTML)
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data: https://www.google.com; connect-src 'none';`
        ],
      },
    });
  });

  mainWindow.loadURL('app://./index.html');
  // ready-to-show fires AFTER first paint — true fix for black flash
  // did-finish-load fires too early (HTML loaded but JS not yet rendered)
  mainWindow.once('ready-to-show', () => {
    if (!_SILENT_LAUNCH) {
      mainWindow.show();
      mainWindow.focus();
    }
    // Navigate to pending section if app was launched from a notification
    if (_pendingSection) {
      const _secDelay = _HW_TIER === 0 ? 4000 : _HW_TIER === 1 ? 3000 : 2000;
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('navigate-to-section', _pendingSection);
        }
        _pendingSection = null;
      }, _secDelay);
    }
  });
  // Fallback: force show after 8s on OEM, 5s on normal (generous for slow systems) — only if not silent
  setTimeout(() => { if (!_SILENT_LAUNCH && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show(); }, _HW_TIER === 0 ? 10000 : _HW_TIER === 1 ? 6000 : 5000);
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('close', (e) => {
    if (tray) { e.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  let iconPath = null;
  try {
    const p = path.join(__dirname, 'build', 'appx', 'Square44x44Logo.png');
    // Use existsSync here only — this runs synchronously at startup before any IPC
    if (fs.existsSync(p)) iconPath = p;
    else { const p2 = path.join(__dirname, 'build', 'icon.ico'); if (fs.existsSync(p2)) iconPath = p2; }
  } catch (_) {}

  tray = new Tray(iconPath || path.join(__dirname, 'build', 'icon.ico'));
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open PC Smart Utility', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: 'Share App', click: () => shell.openExternal(STORE_URL).catch(() => {}) },
    { type: 'separator' },
    { label: 'Quit', click: () => { if (tray) { tray.destroy(); tray = null; } app.quit(); } },
  ]);
  tray.setToolTip('PC Smart Utility');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

// ── GPU / Rendering — OEM-safe black screen prevention ──────────────────
// Targets: Intel UHD (Dell, HP, Lenovo), AMD Radeon iGPU, older Nvidia
// Rule: never disable-gpu + disable-software-rasterizer together → black screen.
// OEM SAFE: on Dell/Alienware we skip D3D entirely to avoid driver conflicts.

// 1. Skip shader disk cache — reduces startup I/O noise (all systems)
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// 2. Software compositing fallback — prevents black on Intel iGPU
app.commandLine.appendSwitch('disable-gpu-compositing');

// 3. SwiftShader fallback if GPU driver broken
app.commandLine.appendSwitch('use-gl', 'swiftshader-webgl');

// 4. Disable GPU vsync — fixes black flash on Dell/HP models at boot
app.commandLine.appendSwitch('disable-gpu-vsync');

// 5. Skip GPU info collection — hangs on some Intel/OEM driver versions
app.commandLine.appendSwitch('disable-gpu-process-crash-limit');

// 6. Force sRGB — fixes washed/black colors on some iGPUs
app.commandLine.appendSwitch('force-color-profile', 'srgb');

// 7-8. Hardware rendering: safe software mode on slow/medium tier, D3D9 on fast
if (_HW_TIER === 0) {
  // Slow tier: full software rendering — avoids all OEM driver conflicts
  app.commandLine.appendSwitch('disable-d3d11');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
} else {
  // Medium/fast: D3D9 more stable than D3D11 on older Intel/AMD drivers
  app.commandLine.appendSwitch('disable-d3d11');
  app.commandLine.appendSwitch('use-angle', 'd3d9');
}

// 9. Suppress GPU/rendering console noise
app.commandLine.appendSwitch('log-level', '3');

// 10. SharedArrayBuffer — needed for some rendering paths
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

// 11. Slow/medium tier: disable background GPU tasks to free up WMI bandwidth
if (_HW_TIER <= 1) {
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-gpu-program-cache');
}

// Must be called before app is ready
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
}]);

// Single-instance lock — if app is already running (e.g. in tray) and the user
// clicks the quiz notification (which re-launches the exe with --quiz-notify),
// forward the argument to the running instance and quit the new one.
const _gotLock = app.requestSingleInstanceLock();
if (!_gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--quiz-notify') || argv.includes('--clean-notify')) {
      _handleNotifyArgs(argv);
    } else {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
    }
  });
}

app.whenReady().then(() => {
  registerAppProtocol();
  // Register pcsmartutility:// deep-link so Toast notifications can navigate
  // to specific pages when clicked (MSIX/Store builds).
  registerDeepLinkProtocol(
    app,
    () => mainWindow,
    (page) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('navigate-to-section', page);
      }
    }
  );
  createWindow();
  createTray();
  // OEM-safe staged startup:
  // - Scheduler starts after short delay (avoids boot I/O spike)
  // - All hardware prewarm is staged with OEM-aware delays
  // - On Dell/OEM: extra 800ms buffer before any WMI/CIM calls

  // Stage 0: Async init of prefs/schedule caches (replaces sync readFileSync on hot paths)
  // Stage 1: Wait for settings caches to load from disk FIRST, then register schedulers
  // FIX: initSchedCache/initPrefsCache are async — must await both before reading settings,
  // otherwise loadSchedule()/loadQuizSettings() return defaults and Task Scheduler gets
  // registered with wrong time or wrong enabled state (user's saved settings ignored).
  Promise.all([
    initPrefsCache().catch(() => {}),
    initSchedCache().catch(() => {}),
  ]).then(() => {
    setTimeout(() => {
      startScheduler();
      scheduleQuizNotification(); // start quiz reminder — fires even when window hidden
      // Sync Windows Task Scheduler so notification fires even if app is fully closed
      const _qs = loadQuizSettings();
      if (_qs && _qs.enabled) { _registerQuizTask(); }
      else { _unregisterQuizTask(); }
      const _cs = loadSchedule();
      if (_cs && _cs.enabled) { _registerCleanTask(_cs); }
      else { _unregisterCleanTask(); }
    }, 200 + _OEM_DELAY_MS);
  });

  // Stage 2: Fast prewarms — battery + sysinfo (most critical for dashboard)
  setTimeout(() => {
    prewarmBattery().catch(() => {});
    // First-launch: write default schedule if missing
    fs.promises.access(SCHEDULE_FILE).catch(() => {
      fs.promises.writeFile(SCHEDULE_FILE, JSON.stringify(
        { enabled: true, hour: 13, minute: 0, days: [], lastRan: null, cleanRecycleBin: true }, null, 2
      ), 'utf8').catch(() => {});
    });
  }, 400 + _OEM_DELAY_MS);

  // Stage 3: sysInfo (medium cost — CPU, RAM, OS info via systeminformation)
  setTimeout(() => {
    prewarmSysInfo().catch(() => {});
  }, 700 + _OEM_DELAY_MS);

  // Stage 4: Disk (expensive — WMI Win32_DiskDrive). Deferred well past window show.
  // OEM/low-RAM tier gets extra 4s buffer so window is fully interactive first.
  setTimeout(() => {
    prewarmDisk().catch(() => {});
  }, 6000 + (_HW_TIER === 0 ? 4000 : _HW_TIER === 1 ? 2000 : 0));

  // Stage 5: Graphics (heaviest WMI — Win32_VideoController + GPU telemetry).
  // FIX-6: Separated from disk (was same setTimeout → both fired together causing
  // dual WMI storm at launch). Skipped entirely on HW_TIER=0 (low-end OEM) until
  // user manually opens GPU section — avoids cold-launch Not Responding on 4GB RAM.
  if (_HW_TIER > 0) {
    setTimeout(() => {
      prewarmGraphics().catch(() => {});
    }, 18000 + (_HW_TIER === 1 ? 3000 : 0));
  }
  // HW_TIER=0: graphics prewarm skipped at startup. get-graphics IPC will run it
  // on-demand when user opens the GPU section (already handled by existing handler).

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(err => {
  try {
    const logPath = require('path').join(require('os').homedir(), 'pc-smart-crash.log');
    require('fs').appendFileSync(logPath, `[${new Date().toISOString()}] app.whenReady error: ${err?.stack || err?.message}\n`);
  } catch(_) {}
  console.error('[pcsu] app.whenReady error:', err);
});

ipcMain.on('share-app', () => shell.openExternal(STORE_URL).catch(() => {}));

app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !tray) app.quit(); });

// ── GPU process crash → reload with software fallback (prevents black screen at runtime) ──
let _gpuCrashCount = 0;
app.on('gpu-process-crashed', (event, killed) => {
  _gpuCrashCount++;
  try {
    // Log crash for diagnostics
    const logPath = path.join(os.homedir(), 'pc-smart-crash.log');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] GPU crash #${_gpuCrashCount} killed=${killed} OEM=${_OEM_SAFE_MODE}\n`);
  } catch (_) {}
  // Persist crash count so disableHardwareAcceleration kicks in on next restart
  try {
    _gpuCrashPersistCount++;
    require('fs').writeFileSync(_GPU_CRASH_FILE,
      JSON.stringify({ count: _gpuCrashPersistCount, ts: Date.now() }), 'utf8');
  } catch (_) {}
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (_gpuCrashCount >= 2) {
        // Immediate software fallback for current session
        // NOTE: do NOT use 'disable-gpu' here — combining it with use-gl=swiftshader causes black screen
        // Instead switch to pure swiftshader ANGLE which renders correctly without the GPU process
        try {
          app.commandLine.appendSwitch('use-angle', 'swiftshader');
          app.commandLine.appendSwitch('use-gl', 'swiftshader');
        } catch (_) {}
      }
      if (_gpuCrashCount >= 3 && _gpuCrashPersistCount >= 3) {
        // Full hardware acceleration disable — most aggressive fallback
        try { app.disableHardwareAcceleration(); } catch (_) {}
      }
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
      }, _gpuCrashCount >= 2 ? 1500 : 500);
    }
  } catch (_) {}
});

// ── Render process gone (crash/OOM) → reload instead of showing blank window ──
app.on('render-process-gone', (event, webContents, details) => {
  try {
    if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.reload();
        }
      }, 500);
    }
  } catch (_) {}
});

app.on('before-quit', () => {
  if (scheduleTimer) { clearInterval(scheduleTimer); scheduleTimer = null; }
  // Full cleanup on quit — prevent memory leaks / lingering state
  _cleanerRunning = false;
  _healthCache = null;
  // Flush debounced analytics to disk synchronously before exit (data would be lost otherwise)
  try {
    if (_analyticsCache && _analyticsFlushTimer) {
      clearTimeout(_analyticsFlushTimer); _analyticsFlushTimer = null;
      fs.writeFileSync(_ANALYTICS_FILE, JSON.stringify(_analyticsCache, null, 0), 'utf8');
    }
  } catch(_) {}
  // Clear all IPC pending queues
  try { Object.keys(_ipcChains).forEach(k => { _ipcChains[k] = Promise.resolve(); _ipcPending[k] = 0; }); } catch(_) {}
});

// ── BATTERY CARE MODE ─────────────────────────────────────────────────────────
// Notifies user to plug in (≤20%) or unplug (≥80%) for battery longevity.
// Edge-triggered: fires ONCE when crossing the threshold, not repeatedly.
let _battCareLastAlert = { low: 0, high: 0 };
let _battCarePrevPct = -1; // track previous % to detect threshold crossing
const BATT_ALERT_COOLDOWN = 60 * 60 * 1000; // 1 hr cooldown (prevents re-alert if user ignores)

function checkBatteryCare(pct, isCharging, acConnected) {
  if (!pct || pct <= 0 || pct > 100) return;
  const now = Date.now();
  const prev = _battCarePrevPct;

  // LOW: only fire when crossing DOWN through 20% (was above, now at or below)
  if (pct <= 20 && !acConnected && (prev < 0 || prev > 20) && (now - _battCareLastAlert.low) > BATT_ALERT_COOLDOWN) {
    _battCareLastAlert.low = now;
    try { new Notification({ title: '🔋 Battery Low — PC Smart Utility', body: `Battery reached ${pct}%. Plug in your charger to protect battery health.`, silent: false }).show(); } catch (_) {}
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('battery-care-alert', { type: 'low', pct });
  }
  // HIGH: only fire when crossing UP through 80% (was below, now at or above)
  if (pct >= 80 && isCharging && (prev < 0 || prev < 80) && (now - _battCareLastAlert.high) > BATT_ALERT_COOLDOWN) {
    _battCareLastAlert.high = now;
    try { new Notification({ title: '🔌 Unplug Charger — PC Smart Utility', body: `Battery reached ${pct}%. Unplug to keep 20–80% range for longer battery life.`, silent: true }).show(); } catch (_) {}
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('battery-care-alert', { type: 'high', pct });
  }

  _battCarePrevPct = pct;
}
// Check on charger unplug event
app.whenReady().then(() => {
  try {
    powerMonitor.on('on-battery', () => {
      setTimeout(() => checkBatteryCare(_battPMCache.percent, false, false), 2000);
    });
  } catch (_) {}
});
// Passive check every 5 minutes — piggybacks on existing battery cache, no extra calls
setInterval(() => {
  if (_battPMCache.hasBattery && _battPMCache.ts > 0) {
    checkBatteryCare(_battPMCache.percent, _battPMCache.isCharging, _battPMCache.acConnected);
  }
}, 5 * 60 * 1000);
// ─────────────────────────────────────────────────────────────────────────────

// ── Monitoring pause/resume helpers ─────────────────────────────────────────
// Called before/after every cleaner scan to prevent OEM I/O contention
function pauseMonitoring() {
  _cleanerRunning = true;
  // Notify renderer to stop polling get-realtime / get-battery during scan
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('monitoring-paused', true);
    }
  } catch (_) {}
}
function resumeMonitoring() {
  _cleanerRunning = false;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('monitoring-paused', false);
    }
  } catch (_) {}
}

// ── IPC Handlers ──────────────────────────────────────────────────────────

// ── Instant info — zero WMI, zero disk, pure os module (<50ms always) ────────
// Used as immediate "backup data" when rocket loads > 10s on slow systems.
// These Node.js os calls NEVER hang — they read kernel memory directly.
safeHandle('get-instant-info', async () => {
  try {
    const uptimeSec = os.uptime();
    const totalRam  = os.totalmem();
    const freeRam   = os.freemem();
    const usedRam   = totalRam - freeRam;
    const cpus      = os.cpus();
    const uptimeStr = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;
    const totalGB   = (totalRam / 1073741824).toFixed(1);
    const usedGB    = (usedRam  / 1073741824).toFixed(1);
    const freeGB    = (freeRam  / 1073741824).toFixed(1);
    const ramPct    = Math.round((usedRam / totalRam) * 100);
    return {
      ok: true,
      hostname:  os.hostname()  || null,
      platform:  os.platform()  || null,
      arch:      os.arch()      || null,
      uptime:    uptimeStr,
      ram:       { totalGB, usedGB, freeGB, pct: ramPct },
      cpuModel:  cpus?.[0]?.model || null,
      cpuCount:  cpus?.length     || null,
      isOemSafe: _OEM_SAFE_MODE,
      isSlowDisk: _IS_SLOW_DISK,
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

safeHandle('get-system-info', async (_, forceRefresh) => {
  if (forceRefresh) { CACHE.sysInfo.ts = 0; }
  try {
    const info = await prewarmSysInfo();
    if (info && info.ok !== false) {
      info._oemSafeMode = _OEM_SAFE_MODE;
    }
    return info;
  }
  catch (e) { return { ok: false, error: e.message }; }
});

safeHandle('get-realtime', async () => {
  // ── Pause realtime polling during cleaner scans ──────────────────────────
  // Cleaner does heavy disk I/O; concurrent monitoring causes hangs on OEM
  if (_cleanerRunning) {
    return { ok: true, paused: true, cpu: null, ram: null, drives: [], net: { rx: '0 KB/s', tx: '0 KB/s' }, gpu: null };
  }
  try {
    // OEM-safe: 4s timeout (vs 3s) — Dell systems have slower WMI responses
    const _tout_ms = _HW_TIER === 0 ? 6000 : _HW_TIER === 1 ? 4000 : 3000;
    const tout = (p) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(null), _tout_ms))]).catch(() => null);
    // FIX-3: getCpuLoadFast() uses os.cpus() delta — zero WMI, no OEM stall possible
    // si.currentLoad() (old) called Win32_PerfFormattedData every 5s → Dell/HP freeze
    const cpuLoad = getCpuLoadFast();
    // FIX-4: getFsSizeCached() — 30s TTL, prevents disk thrash + antivirus trigger on every poll
    const [mem, fsSize, netStats] = await Promise.all([
      siSafe(si.mem(), _tout_ms), getFsSizeCached(),
      siSafe(si.networkStats(), _tout_ms),
    ]);
    if (!cpuLoad || !mem) return { ok: false, error: 'System data unavailable' };
    const seen = new Set();
    const drives = (fsSize || [])
      .filter(d => d && d.size > 100 * 1024 * 1024)
      .filter(d => { const k = d.fs || d.mount; if (seen.has(k)) return false; seen.add(k); return true; })
      .map(d => {
        const total = +(d.size / 1073741824).toFixed(2);
        const used  = +(d.used / 1073741824).toFixed(2);
        const free  = +((d.size - d.used) / 1073741824).toFixed(2);
        const pct   = d.size > 0 ? Math.min(100, Math.max(0, Math.round((d.used / d.size) * 100))) : 0;
        return { label: d.fs || d.mount, mount: d.mount, total, used, free, pct };
      });
    const coreLoads = (cpuLoad?.cpus || []).map((c, i) => ({ core: i, load: +(c?.load || 0).toFixed(1) }));
    const memTotal = (mem?.total || 0) > 0 ? mem.total : 1;

    // Network throughput (sum all non-loopback interfaces)
    const netArr = Array.isArray(netStats) ? netStats : (netStats ? [netStats] : []);
    const netTotals = netArr.filter(n => n && !n.iface?.toLowerCase().includes('lo')).reduce(
      (acc, n) => { acc.rx += (n.rx_sec || 0); acc.tx += (n.tx_sec || 0); return acc; },
      { rx: 0, tx: 0 }
    );
    const fmtNet = (b) => b < 0 ? '0 KB/s' : b < 1024 * 1024 ? (b / 1024).toFixed(1) + ' KB/s' : (b / 1048576).toFixed(2) + ' MB/s';

    // GPU: use cached graphics data instead of fresh si.graphics() call on every poll
    // si.graphics() calls WMI/CIM — too expensive to run every 2 seconds
    // We use the prewarm cache (10 min TTL) and skip GPU realtime if cache is cold
    const gpuData = cacheGet('graphics');
    const gpuControllers = gpuData?._rawControllers || gpuData?.controllers || [];
    const gpu = gpuControllers[0] || null;

    return {
      ok: true,
      cpu: { load: +(cpuLoad?.currentLoad || 0).toFixed(1), coreLoads },
      ram: {
        total: +((mem?.total    || 0) / 1073741824).toFixed(1),
        used:  +((mem?.active   || 0) / 1073741824).toFixed(1),
        free:  +((mem?.available|| 0) / 1073741824).toFixed(1),
        pct:   +(((mem?.active  || 0) / memTotal) * 100).toFixed(1),
      },
      drives,
      net: { rxRaw: netTotals.rx, txRaw: netTotals.tx, rx: fmtNet(netTotals.rx), tx: fmtNet(netTotals.tx) },
      gpu: gpu ? {
        name: gpu.model || 'GPU',
        usage: gpu.utilizationGpu ?? null,
        vramUsed: gpu.memoryUsed ?? null,
        vramTotal: gpu.memoryTotal ?? null,
        temp: gpu.temperatureGpu ?? null,
      } : null,
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

safeHandle('get-battery', async () => {
  // FIX-5: powerMonitor handles ac/charging state (instant, zero WMI).
  // si.battery() called max once per 60s for percent only.
  // Eliminates Dell SupportAssist / HP Wolf / Lenovo Vantage Win32_Battery deadlocks.
  try {
    const age = Date.now() - _battPMCache.ts;
    if (age < 60000 && _battPMCache.ts > 0) {
      // Cache still fresh — return immediately, no system call
      return { ok: true, ..._battPMCache };
    }
    // Refresh percent via si.battery() with hard 4s timeout
    const bat = await Promise.race([
      si.battery(),
      new Promise(res => setTimeout(() => res(null), 4000))
    ]);
    if (!bat || !bat.hasBattery) {
      _battPMCache.hasBattery = false;
      return { ok: true, hasBattery: false };
    }
    _battPMCache = {
      hasBattery:      true,
      percent:         Math.round(bat.percent || 0),
      isCharging:      _battPMCache.ts === 0 ? (bat.isCharging || false) : _battPMCache.isCharging,
      acConnected:     _battPMCache.ts === 0 ? (bat.acConnected || !bat.isDischarging || false) : _battPMCache.acConnected,
      voltage:         bat.voltage         || null,
      maxCapacity:     bat.maxCapacity     || null,
      designedCapacity:bat.designedCapacity|| null,
      ts: Date.now()
    };
    return { ok: true, ..._battPMCache };
  } catch (_) {
    // On any error return last known cache — never freeze
    return { ok: true, ..._battPMCache };
  }
});

safeHandle('get-cpu-temperature', async () => {
  try {
    const t = await siSafe(si.cpuTemperature(), 6000) || {};
    return {
      ok: true,
      main:  t.main  !== null && t.main  !== -1 ? +t.main.toFixed(1)  : null,
      max:   t.max   !== null && t.max   !== -1 ? +t.max.toFixed(1)   : null,
      cores: Array.isArray(t.cores) ? t.cores.filter(v => v !== null && v !== -1).map(v => +v.toFixed(1)) : [],
      socket: Array.isArray(t.socket) ? t.socket.filter(v => v !== null && v !== -1).map(v => +v.toFixed(1)) : [],
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

safeHandle('get-disk-layout', async (_, forceRefresh) => {
  if (forceRefresh) { CACHE.diskLayout.ts = 0; }
  try { return await prewarmDisk(); }
  catch (e) { return { ok: false, error: e.message }; }
});

safeHandle('get-graphics', async (_, forceRefresh) => {
  if (forceRefresh) { CACHE.graphics.ts = 0; }
  try { return await prewarmGraphics(); }
  catch (_) { return { ok: false }; }
});

safeHandle('get-net-ifaces', async () => {
  try {
    const result = await prewarmNetIfaces();
    const ifaces = (result.ifaces || [])
      .filter(n => n.mac && n.mac !== '00:00:00:00:00:00')
      .map(n => ({
        name:      n.iface      || n.ifaceName || 'Unknown',
        type:      n.type       || null,
        mac:       n.mac        || null,
        ip4:       n.ip4        || null,
        ip6:       n.ip6        || null,
        speed:     n.speed      || null,
        state:     n.operstate  || null,
        dhcp:      n.dhcp       ?? null,
        internal:  n.internal   ?? false,
      }));
    return { ok: true, ifaces };
  } catch (e) { return { ok: false, error: e.message }; }
});

let _procsCache = null; let _procsCacheTs = 0;
safeHandle('get-processes', async () => {
  try {
    if (_procsCache && (Date.now() - _procsCacheTs) < 5000) return _procsCache;
    const tout = (p) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))]);
    const procs = await tout(si.processes());
    const top = procs.list.filter(p => p.name).sort((a, b) => (b.cpu || 0) - (a.cpu || 0)).slice(0, 15)
      .map(p => ({ name: p.name, cpu: (p.cpu || 0).toFixed(1), mem: ((p.memRss || 0) / 1048576).toFixed(0), pid: p.pid }));
    const pr = { ok: true, list: top, total: procs.all };
    _procsCache = pr; _procsCacheTs = Date.now();
    return pr;
  } catch (e) { return { ok: false, error: e.message }; }
});

safeHandle('get-network-info', async () => {
  const r = await safeExec('ipconfig /all', { timeout: 8000 });
  return { ok: r.ok, output: r.out || r.err };
});

safeHandle('ping-host', async (_, host) => {
  const h = (host || '8.8.8.8').replace(/[^a-zA-Z0-9.\-]/g, '').substring(0, 253);
  if (!h) return { ok: false, output: 'Invalid host' };
  // Use -n 1 so continuous mode does not stack calls; one clean result per interval
  const r = await safeExec(`ping -n 1 -w 3000 ${h}`, { timeout: 6000 });
  return { ok: r.ok, output: r.out || r.err, host: h };
});

safeHandle('flush-dns', async () => {
  const r = await safeExec('ipconfig /flushdns', { timeout: 8000 });
  return { ok: r.ok, message: r.ok ? 'DNS cache flushed successfully.' : r.err };
});

safeHandle('check-internet', async () => {
  // ping 8.8.8.8 fails on ISPs/routers that block ICMP — use HTTP instead
  try {
    const { net } = require('electron');
    if (!net.isOnline()) return { ok: false };
    const resp = await fetch('https://www.msftconnecttest.com/connecttest.txt', {
      signal: AbortSignal.timeout(4000),
    });
    return { ok: resp.ok };
  } catch (_) {
    try { const { net } = require('electron'); return { ok: net.isOnline() }; }
    catch (_2) { return { ok: false }; }
  }
});

safeHandle('get-wifi-strength', async () => {
  const r = await safeExec('netsh wlan show interfaces', { timeout: 6000 });
  if (!r.ok || !r.out) return { ok: false, signal: null, ssid: null };
  const stateMatch = r.out.match(/State\s*:\s*(.+)/i);
  const state = stateMatch ? stateMatch[1].trim().toLowerCase() : '';
  const sig = r.out.match(/Signal\s*:\s*(\d+)%/i);
  const ssid = r.out.match(/^\s*SSID\s*:\s*(.+)$/im);
  const iface = r.out.match(/Name\s*:\s*(.+)/i);
  const connected = state.includes('connected');
  if (!connected && !sig) {
    const r2 = await safeExec('ipconfig', { timeout: 4000 });
    const hasWifi = r2.out && r2.out.toLowerCase().includes('wireless');
    return { ok: hasWifi, signal: null, ssid: hasWifi ? 'Connected (signal unreadable)' : null, connected: hasWifi };
  }
  return {
    ok: true,
    signal: sig ? parseInt(sig[1]) : null,
    ssid: ssid ? ssid[1].trim() : (connected ? 'Connected' : null),
    iface: iface ? iface[1].trim() : 'Wi-Fi',
    connected: connected || !!sig,
  };
});

safeHandle('nslookup', async (_, domain) => {
  const d = (domain || 'google.com').replace(/[^a-zA-Z0-9.\-]/g, '').substring(0, 253);
  if (!d) return { ok: false, output: 'Invalid domain' };
  const r = await safeExec(`nslookup ${d}`, { timeout: 10000 });
  return { ok: r.ok, output: r.out || r.err };
});

safeHandle('tracert', async (_, host) => {
  const h = (host || '8.8.8.8').replace(/[^a-zA-Z0-9.\-]/g, '').substring(0, 253);
  if (!h) return { ok: false, output: 'Invalid host' };
  const r = await safeExec(`tracert -d -h 20 ${h}`, { timeout: 25000 });
  return { ok: r.ok, output: r.out || r.err };
});

safeHandle('port-check', async (_, host, port) => {
  const safeHost = (host || '127.0.0.1').replace(/[^a-zA-Z0-9.\-]/g, '').substring(0, 253);
  const safePort = Math.max(1, Math.min(65535, parseInt(port) || 80));
  if (!safeHost) return { ok: false, open: false };
  const r = await safeExec(
    `powershell -NoProfile -NonInteractive -Command "Test-NetConnection -ComputerName ${safeHost} -Port ${safePort} -InformationLevel Quiet -WarningAction SilentlyContinue"`,
    { timeout: 12000 }
  );
  return { ok: true, open: r.out.toLowerCase().includes('true'), host: safeHost, port: safePort };
});

safeHandle('get-public-ip', async () => {
  return new Promise(resolve => {
    try {
      const req = https.get('https://api.ipify.org', { timeout: 6000 }, res => {
        let data = ''; res.on('data', d => data += d); res.on('end', () => resolve({ ok: true, ip: data.trim() }));
      });
      req.on('error', () => resolve({ ok: false }));
      req.setTimeout(6000, () => { req.destroy(); resolve({ ok: false }); });
    } catch (_) { resolve({ ok: false }); }
  });
});

safeHandle('run-cmd', async (_, key) => {
  const cmd = CMD_WHITELIST[key];
  if (!cmd) return { ok: false, output: 'Command not in allowlist.' };
  const r = await safeExec(cmd, { timeout: 15000 });
  return { ok: r.ok, output: r.out || r.err || 'No output returned.' };
});

safeHandle('run-cmd-input', async (_, type, input) => {
  const sanitized = (input || '').replace(/[^a-zA-Z0-9.\-_:@]/g, '').substring(0, 253);
  if (!sanitized) return { ok: false, output: 'Invalid input.' };
  let cmd = '';
  if (type === 'nslookup') cmd = `nslookup ${sanitized}`;
  else if (type === 'tracert') cmd = `tracert -d -h 20 ${sanitized}`;
  else if (type === 'ping') cmd = `ping -n 4 -w 2000 ${sanitized}`;
  else return { ok: false, output: 'Unknown command type.' };
  const r = await safeExec(cmd, { timeout: 15000 });
  return { ok: r.ok, output: r.out || r.err };
});

safeHandle('get-env-vars', async () => {
  const SAFE_KEYS = ['USERNAME','COMPUTERNAME','OS','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS',
    'PROCESSOR_IDENTIFIER','TEMP','TMP','PATH','SYSTEMROOT','SYSTEMDRIVE',
    'PROGRAMFILES','PROGRAMFILES(X86)','USERPROFILE','APPDATA','LOCALAPPDATA',
    'WINDIR','HOMEDRIVE','HOMEPATH','PUBLIC','ALLUSERSPROFILE'];
  const result = {};
  SAFE_KEYS.forEach(k => { if (process.env[k]) result[k] = process.env[k]; });
  return { ok: true, vars: result };
});

safeHandle('get-hosts-file', async () => {
  try {
    const hostsPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
    const content = await fs.promises.readFile(hostsPath, 'utf8');
    return { ok: true, content };
  } catch (e) { return { ok: false, content: 'Could not read hosts file: ' + e.message }; }
});

safeHandle('get-installed-software', async () => {
  const r = await safeExec(
    `powershell -NoProfile -NonInteractive -Command "$a=@();'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'|ForEach-Object{Get-ItemProperty $_ -EA SilentlyContinue|Where-Object{$_.DisplayName}|ForEach-Object{$a+=[PSCustomObject]@{N=$_.DisplayName;V=$_.DisplayVersion;P=$_.Publisher;D=$_.InstallDate}}};$a|Sort-Object N|ConvertTo-Json -Compress"`,
    { timeout: 15000 }
  );
  if (!r.out) return { ok: false, apps: [] };
  try {
    const raw = JSON.parse(r.out);
    const arr = Array.isArray(raw) ? raw : [raw];
    const seen = new Set();
    return { ok: true, apps: arr.filter(a => a.N && !seen.has(a.N) && seen.add(a.N)).map(a => ({ name: a.N, version: a.V || 'N/A', publisher: a.P || 'N/A', date: a.D || 'N/A' })) };
  } catch (_) { return { ok: false, apps: [] }; }
});

safeHandle('open-uninstall-settings', async () => { shell.openExternal('ms-settings:appsfeatures').catch(() => {}); return { ok: true }; });

safeHandle('get-startup-apps', async () => {
  const r = await safeExec(
    `powershell -NoProfile -NonInteractive -Command "$a=@();@('HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run','HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run')|ForEach-Object{$p=$_;try{$props=Get-ItemProperty -Path $p -EA Stop;$props.PSObject.Properties|Where-Object{$_.Name -notlike 'PS*'}|ForEach-Object{$a+=[PSCustomObject]@{Name=$_.Name;Cmd=$_.Value;Loc=$p}}}catch{}};$a|ConvertTo-Json -Compress"`,
    { timeout: 12000 }
  );
  if (!r.out) return { ok: true, apps: [] };
  try {
    const raw = JSON.parse(r.out);
    return { ok: true, apps: (Array.isArray(raw) ? raw : [raw]).map(a => ({ name: a.Name, cmd: a.Cmd, loc: a.Loc })) };
  } catch (_) { return { ok: true, apps: [] }; }
});

safeHandle('open-startup-settings', async () => { shell.openExternal('ms-settings:startupapps').catch(() => {}); return { ok: true }; });


// ── Arc browser path resolver ────────────────────────────────────────────────
// The APPX package suffix (e.g. ttt1ap7aakyb4) varies per Windows installation.
// We glob the Packages folder instead of hardcoding it.
async function resolveArcUserDataPath(home) {
  const pkgsDir = path.join(home, 'AppData', 'Local', 'Packages');
  try {
    const accessible = await fs.promises.access(pkgsDir).then(() => true).catch(() => false);
    if (!accessible) return null;
    const entries = await fs.promises.readdir(pkgsDir).catch(() => []);
    const arcPkg = entries.find(e => e.startsWith('TheBrowserCompany.Arc_'));
    if (!arcPkg) return null;
    return path.join(pkgsDir, arcPkg, 'LocalCache', 'Local', 'Arc', 'User Data');
  } catch (_) { return null; }
}

safeHandle('estimate-sizes', async () => {
  // Pause monitoring during disk scan to prevent OEM hangs
  const wasRunning = _cleanerRunning;
  _cleanerRunning = true;
  try {
    const home = os.homedir();
    const tempDir = os.tmpdir();
    const altTemp = path.join(home, 'AppData', 'Local', 'Temp');
    const estimates = {};

    // Fully async — no readdirSync/statSync
    const [tempSize, altTempSize, thumbSize, recentSize] = await Promise.all([
      getFolderSizeAsync(tempDir, 8000),
      altTemp !== tempDir ? getFolderSizeAsync(altTemp, 5000) : Promise.resolve(0),
      getThumbcacheFilesSizeAsync(path.join(home, 'AppData', 'Local', 'Microsoft', 'Windows', 'Explorer')),
      getFolderSizeAsync(path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Recent'), 200),
    ]);
    estimates.temp = tempSize + altTempSize;
    estimates.thumbcache = thumbSize;
    estimates.recent = recentSize;

    const arcPath = await resolveArcUserDataPath(home);
    const browserRoots = {
      chrome:  path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
      edge:    path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
      firefox: path.join(home, 'AppData', 'Local', 'Mozilla', 'Firefox', 'Profiles'),
      brave:   path.join(home, 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data'),
      opera:   path.join(home, 'AppData', 'Local', 'Opera Software', 'Opera Stable'),
      vivaldi: path.join(home, 'AppData', 'Local', 'Vivaldi', 'User Data'),
      arc:     arcPath,
      yandex:  path.join(home, 'AppData', 'Local', 'Yandex', 'YandexBrowser', 'User Data'),
      whale:   path.join(home, 'AppData', 'Local', 'Naver', 'Naver Whale', 'User Data'),
      coccoc:  path.join(home, 'AppData', 'Local', 'CocCoc', 'Browser', 'User Data'),
    };
    const chromiumCacheSubs = ['Cache', 'Code Cache', 'GPUCache', 'Service Worker\\CacheStorage'];

    // Async profile folder scanner — no statSync/readdirSync
    async function getChromiumProfileFoldersAsync(userDataDir) {
      const profiles = [];
      try {
        const accessible = await fs.promises.access(userDataDir).then(() => true).catch(() => false);
        if (!accessible) return [path.join(userDataDir, 'Default')];
        const entries = await fs.promises.readdir(userDataDir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name) || entry.name === 'Guest Profile' || entry.name === 'System Profile')) {
            profiles.push(path.join(userDataDir, entry.name));
          }
        }
      } catch (_) {}
      if (!profiles.length) profiles.push(path.join(userDataDir, 'Default'));
      return profiles;
    }

    async function getBrowserCacheSize(userDataDir, isFirefox) {
      try {
        if (!userDataDir) return 0;
        const accessible = await fs.promises.access(userDataDir).then(() => true).catch(() => false);
        if (!accessible) return 0;
        let folders = [];
        if (isFirefox) {
          folders = [userDataDir];
        } else {
          const profileDirs = await getChromiumProfileFoldersAsync(userDataDir);
          for (const prof of profileDirs) {
            for (const sub of chromiumCacheSubs) {
              const p = path.join(prof, sub);
              const ok = await fs.promises.access(p).then(() => true).catch(() => false);
              if (ok) folders.push(p);
            }
          }
          if (!folders.length) {
            for (const sub of chromiumCacheSubs) {
              const p = path.join(userDataDir, sub);
              const ok = await fs.promises.access(p).then(() => true).catch(() => false);
              if (ok) folders.push(p);
            }
          }
        }
        if (!folders.length) return 0;
        const pathList = folders.map(p => `'${p.replace(/'/g, "''")}'`).join(',');
        const ps = `$total=0;@(${pathList})|ForEach-Object{try{$total+=(Get-ChildItem -Path $_ -Recurse -File -ErrorAction SilentlyContinue|Measure-Object -Property Length -Sum -ErrorAction SilentlyContinue).Sum}catch{}};$total`;
        const r = await safeExec(`powershell -NoProfile -NonInteractive -Command "${ps}"`, { timeout: 10000 });
        const val = parseInt((r.out || '0').trim());
        return isNaN(val) ? 0 : val;
      } catch (_) { return 0; }
    }

    const browserEntries = Object.entries(browserRoots);
    const browserSizes = await Promise.all(
      browserEntries.map(([name, root]) => getBrowserCacheSize(root, name === 'firefox'))
    );
    browserEntries.forEach(([name], i) => { estimates[name] = browserSizes[i]; });
    return { ok: true, estimates };
  } finally {
    _cleanerRunning = wasRunning;
  }
});

safeHandle('clean-temp', async () => {
  if (_cleanerRunning) return { ok: false, message: 'Another clean is in progress. Please wait.' };
  pauseMonitoring();
  const home = os.homedir();
  const tempPaths = [...new Set([os.tmpdir(), path.join(home, 'AppData', 'Local', 'Temp')])];
  let removed = 0;
  try {
    for (const tp of tempPaths) {
      removed += await deleteFilesChunked(tp);
    }
  } finally {
    resumeMonitoring();
  }
  return { ok: true, message: `Temp cleaned: ${removed} items removed.` };
});

safeHandle('clean-thumbcache', async () => {
  if (_cleanerRunning) return { ok: false, message: 'Another clean is in progress. Please wait.' };
  pauseMonitoring();
  let removed = 0;
  try {
    const home = os.homedir();
    const explorerDir = path.join(home, 'AppData', 'Local', 'Microsoft', 'Windows', 'Explorer');
    // thumbcache_*.db files are held open by explorer.exe while it's running, so
    // deletes silently fail unless Explorer is briefly stopped first (no admin rights needed).
    await new Promise(resolve => exec('taskkill /f /im explorer.exe', { timeout: 5000 }, () => resolve()));
    await new Promise(r => setTimeout(r, 500));
    try {
      removed += await deleteFilesChunked(explorerDir, item => item.startsWith('thumbcache_') && item.endsWith('.db'));
    } finally {
      spawn('explorer.exe', [], { detached: true, stdio: 'ignore' }).unref();
    }
  } finally {
    resumeMonitoring();
  }
  return { ok: true, message: `Thumbnail cache cleaned: ${removed} files removed.` };
});

safeHandle('clean-recent', async () => {
  if (_cleanerRunning) return { ok: false, message: 'Another clean is in progress. Please wait.' };
  pauseMonitoring();
  let removed = 0;
  try {
    const recentPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Recent');
    removed += await deleteFilesChunked(recentPath, item => item.endsWith('.lnk'));
  } finally {
    resumeMonitoring();
  }
  return { ok: true, message: `Recent files cleared: ${removed} shortcuts removed.` };
});

safeHandle('clean-recycle', async () => {
  if (_cleanerRunning) return { ok: false, message: 'Another clean is in progress. Please wait.' };
  pauseMonitoring();
  let removed = 0;
  try {
    // Method 1: direct $Recycle.Bin deletion (async chunked)
    const driveList = await safeExec(
      'powershell -NoProfile -NonInteractive -Command "Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root"',
      { timeout: 5000 }
    );
    const matches = (driveList.out || '').match(/[A-Z]:/g) || ['C:'];
    for (const drive of [...new Set(matches)]) {
      const recyclePath = drive + '\\$Recycle.Bin';
      try {
        const rpAccess = await fs.promises.access(recyclePath).then(() => true).catch(() => false);
        if (!rpAccess) continue;
        const sids = await fs.promises.readdir(recyclePath).catch(() => []);
        for (const sid of sids) {
          const sidPath = path.join(recyclePath, sid);
          try {
            const stat = await fs.promises.stat(sidPath).catch(() => null);
            if (stat && stat.isDirectory()) {
              removed += await deleteFilesChunked(sidPath);
            }
          } catch (_) {}
          await new Promise(r => setImmediate(r));
        }
      } catch (_) {}
    }
    // Method 2: PowerShell Clear-RecycleBin as supplement
    await safeExec(
      'powershell -NoProfile -NonInteractive -Command "Clear-RecycleBin -Force -ErrorAction SilentlyContinue"',
      { timeout: 15000 }
    ).catch(() => {});
  } finally {
    resumeMonitoring();
  }
  const msg = removed > 0
    ? `Recycle Bin emptied: ${removed} item${removed !== 1 ? 's' : ''} deleted.`
    : 'Recycle Bin emptied.';
  return { ok: true, message: msg };
});

safeHandle('clean-browser-cache', async (_, browsers) => {
  if (_cleanerRunning) return { ok: false, message: 'Another clean is in progress. Please wait.' };
  pauseMonitoring();
  if (!Array.isArray(browsers) || browsers.length === 0) { resumeMonitoring(); return { ok: false, message: 'No browsers selected.' }; }
  const home = os.homedir();

  // Build list of all cache folders for each browser (all profiles)
  const allProfilesOf = async (userDataDir) => {
    const profiles = [];
    try {
      const accessible = await fs.promises.access(userDataDir).then(() => true).catch(() => false);
      if (!accessible) return [];
      const entries = await fs.promises.readdir(userDataDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name) || entry.name === 'Guest Profile')) {
          profiles.push(path.join(userDataDir, entry.name));
        }
      }
    } catch(_){}
    if (!profiles.length) {
      const d = path.join(userDataDir, 'Default');
      const ok = await fs.promises.access(d).then(() => true).catch(() => false);
      if (ok) profiles.push(d);
    }
    return profiles;
  };

  const CACHE_SUBS = ['Cache', path.join('Cache','Cache_Data'), path.join('Code Cache','js'), path.join('Code Cache','wasm'), 'GPUCache', path.join('Service Worker','CacheStorage')];

  const cleanPathsFor = async (userDataDir) => {
    const paths = [];
    const profs = await allProfilesOf(userDataDir);
    // Multi-profile Chromium structure
    if (profs.length) {
      for (const prof of profs)
        for (const sub of CACHE_SUBS) {
          const p = path.join(prof, sub);
          const ok = await fs.promises.access(p).then(() => true).catch(() => false);
          if (ok) paths.push(p);
        }
    }
    // Flat structure fallback (Opera Stable)
    if (!paths.length)
      for (const sub of CACHE_SUBS) {
        const p = path.join(userDataDir, sub);
        const ok = await fs.promises.access(p).then(() => true).catch(() => false);
        if (ok) paths.push(p);
      }
    return paths;
  };

  const BROWSER_ROOTS = {
    chrome:  path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
    edge:    path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
    firefox: path.join(home, 'AppData', 'Local', 'Mozilla', 'Firefox', 'Profiles'),
    brave:   path.join(home, 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data'),
    opera:   path.join(home, 'AppData', 'Local', 'Opera Software', 'Opera Stable'),
    vivaldi: path.join(home, 'AppData', 'Local', 'Vivaldi', 'User Data'),
    arc:     await resolveArcUserDataPath(home),
    yandex:  path.join(home, 'AppData', 'Local', 'Yandex', 'YandexBrowser', 'User Data'),
    whale:   path.join(home, 'AppData', 'Local', 'Naver', 'Naver Whale', 'User Data'),
    coccoc:  path.join(home, 'AppData', 'Local', 'CocCoc', 'Browser', 'User Data'),
  };

  // Collect all target folders
  const allPaths = [];
  const notFound = [];
  for (const b of browsers) {
    const root = BROWSER_ROOTS[b];
    if (!root) { notFound.push(b); continue; }
    const accessible = await fs.promises.access(root).then(() => true).catch(() => false);
    if (!accessible) { notFound.push(b); continue; }
    if (b === 'firefox') {
      allPaths.push(root);
    } else {
      const paths = await cleanPathsFor(root);
      if (paths.length) allPaths.push(...paths);
      else notFound.push(b);
    }
  }

  if (!allPaths.length) {
    resumeMonitoring();
    return { ok: true, message: notFound.length
      ? `Browser not installed: ${notFound.join(', ')}.`
      : 'No cache folders found. Browsers may not be installed.' };
  }

  // ── Use PowerShell to delete in background — NEVER blocks the UI ──────────
  const psPathList = allPaths.map(p => `'${p.replace(/'/g, "''")}'`).join(',');
  const psScript = [
    `$paths = @(${psPathList})`,
    `$removed = 0`,
    `foreach ($p in $paths) {`,
    `  if (Test-Path $p) {`,
    `    $items = Get-ChildItem -Path $p -Recurse -Force -ErrorAction SilentlyContinue`,
    `    foreach ($item in $items) {`,
    `      try { Remove-Item -Path $item.FullName -Recurse -Force -ErrorAction Stop; $removed++ } catch {}`,
    `    }`,
    `  }`,
    `}`,
    `Write-Output $removed`,
  ].join('; ');

  let r, removed = 0, msg = '';
  try {
    r = await safeExec(
      `powershell -NoProfile -NonInteractive -Command "${psScript}"`,
      { timeout: 30000 }
    );
    removed = parseInt((r.out || '0').trim()) || 0;
    const cleanedBrowsers = browsers.filter(b => allPaths.length > 0 && BROWSER_ROOTS[b]);
    if (cleanedBrowsers.length > 0) {
      msg = `Cleared ${removed} items from: ${cleanedBrowsers.join(', ')}.`;
      if (removed === 0) msg += ' (Browser may be open — some files were skipped. Close browser for full clean.)';
    } else {
      msg = `No browsers found to clean: ${notFound.join(', ')}.`;
    }
  } finally {
    resumeMonitoring(); // always resume — prevents _cleanerRunning stuck=true on any throw
  }
  return { ok: true, message: msg };
});

safeHandle('copy-to-clipboard', async (_, text) => { try { clipboard.writeText(String(text).substring(0, 10000)); return { ok: true }; } catch(e) { return { ok: false, error: e.message }; } });
// Standalone "Clear Clipboard" quick action (Quick Tools) — just wipes clipboard content, unrelated to the removed Clipboard History feature
safeHandle('clear-clipboard-now', async () => { try { clipboard.writeText(''); return { ok: true }; } catch(e) { return { ok: false, error: e.message }; } });

ipcMain.on('open-tool', (_, key) => openTool(key));
ipcMain.on('open-run-dialog', () => {
  spawn('rundll32.exe', ['shell32.dll,#61'], { detached: true, stdio: 'ignore' }).unref();
});
ipcMain.on('open-settings', (_, uri) => openSettings(uri));
ipcMain.on('open-task-manager', () => openTool('taskmgr'));
ipcMain.on('open-calculator', () => openTool('calc'));
ipcMain.on('open-notepad', () => openTool('notepad'));

const ALLOWED_OPEN_DOMAINS = [
  'speedtest.net', 'www.speedtest.net', 'speed.cloudflare.com',
  'vinay369omix.github.io', 'ko-fi.com',
  // Quick Links domains
  'espn.com', 'cricbuzz.com', 'sports.ndtv.com', 'ndtv.com',
  'zerodha.com', 'groww.in', 'finance.yahoo.com',
  'news.google.com', 'bbc.com', 'bbc.co.uk',
  'claude.ai', 'chat.openai.com', 'openai.com',
  'gemini.google.com', 'google.com', 'v0.dev',
  'github.com', 'stackoverflow.com', 'mdn.io', 'developer.mozilla.org',
  'apps.microsoft.com', 'microsoft.com',
  'youtube.com', 'twitter.com', 'x.com', 'reddit.com',
  'linkedin.com', 'docs.google.com', 'drive.google.com',
];
ipcMain.on('open-url', (_, url) => {
  if (!url) return;
  try {
    const parsed = new URL(url);
    if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      ALLOWED_OPEN_DOMAINS.some(d => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
      shell.openExternal(url).catch(() => {});
    }
  } catch (_) {}
});

// Dedicated MS Store opener — ms-windows-store:// protocol not allowed in open-url whitelist
ipcMain.on('open-store', () => {
  shell.openExternal(STORE_URL).catch(() => {
    shell.openExternal('https://apps.microsoft.com/detail/9NW5DMR2XQ36').catch(() => {});
  });
});

// Rate/review page — goes directly to Write a Review page in MS Store
ipcMain.on('open-store-review', () => {
  shell.openExternal('ms-windows-store://review/?ProductId=9NW5DMR2XQ36').catch(() => {
    shell.openExternal(STORE_URL).catch(() => {
      shell.openExternal('https://apps.microsoft.com/detail/9NW5DMR2XQ36').catch(() => {});
    });
  });
});

ipcMain.on('lock-screen', () => { exec('rundll32.exe user32.dll,LockWorkStation', () => {}); });
ipcMain.on('restart-explorer', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  dialog.showMessageBox(mainWindow, {
    type: 'question', buttons: ['Cancel', 'Restart Explorer'], defaultId: 0,
    title: 'Restart Explorer', message: 'This will briefly close and restart Windows Explorer. Continue?',
  }).then(({ response }) => {
    if (response === 1) {
      exec('taskkill /f /im explorer.exe', { timeout: 5000 }, () => {
        spawn('explorer.exe', [], { detached: true, stdio: 'ignore' }).unref();
      });
    }
  }).catch(err => console.error('[pcsu] dialog error:', err));
});
ipcMain.on('sleep', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  dialog.showMessageBox(mainWindow, {
    type: 'question', buttons: ['Cancel', 'Sleep'], defaultId: 0,
    title: 'Sleep', message: 'Put your computer to sleep?',
  }).then(({ response }) => { if (response === 1) exec('rundll32.exe powrprof.dll,SetSuspendState 0,1,0', () => {}); }).catch(err => console.error('[pcsu] dialog error:', err));
});
ipcMain.on('hibernate', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  dialog.showMessageBox(mainWindow, {
    type: 'question', buttons: ['Cancel', 'Hibernate'], defaultId: 0,
    title: 'Hibernate', message: 'Put your computer into hibernate mode?',
  }).then(({ response }) => { if (response === 1) exec('shutdown /h', () => {}); }).catch(err => console.error('[pcsu] dialog error:', err));
});

// ── Export helpers ────────────────────────────────────────────────────────

async function collectRichReportData_inner() {
  CACHE.battery.ts = 0;
  const [sysResult, diskResult, gfxResult, netIfacesResult, batRaw] = await Promise.all([
    prewarmSysInfo(), prewarmDisk(), prewarmGraphics(), prewarmNetIfaces(),
    prewarmBattery().catch(() => null),
  ]);
  // FIX-6: if this fresh battery query timed out/failed, use the last
  // known-good reading instead of showing "no battery" in the report.
  const bat = (batRaw && batRaw.hasBattery) ? batRaw : (_lastGoodBattery || batRaw);

  let raw = sysResult?._raw || null;
  if (!raw) {
    try {
      const [system2, osInfo2, bios2, cpu2, memLayout2] = await Promise.all([
        siSafe(si.system()), siSafe(si.osInfo()), siSafe(si.bios()), siSafe(si.cpu()), siSafe(si.memLayout()),
      ]);
      raw = { system: system2, osInfo: osInfo2, bios: bios2, cpu: cpu2, memLayout: memLayout2 };
    } catch (_) { raw = {}; }
  }
  if (!raw) raw = {};

  const system = raw.system || {}; const osInfo = raw.osInfo || {};
  const bios = raw.bios || {}; const cpu = raw.cpu || {};
  const memLayout = raw.memLayout || [];
  const diskLayout = (diskResult?._rawDisks) || [];
  const graphics = { controllers: gfxResult?._rawControllers || [] };
  const networkIfaces = netIfacesResult?.ifaces || [];
  const uptimeSec = os.uptime();
  const uptime = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;
  const hostname = os.hostname();

  const ramRows = memLayout.filter(m => m.size > 0).map(m => ({
    Bank: m.bank || 'N/A', Capacity: (m.size / 1073741824).toFixed(0) + ' GB',
    Type: m.type || 'N/A', Speed: m.clockSpeed ? m.clockSpeed + ' MHz' : 'N/A',
    Brand: m.manufacturer || 'N/A', 'Part Number': m.partNum || 'N/A',
  }));
  const totalRam = memLayout.filter(m => m.size > 0).reduce((s, m) => s + m.size, 0);

  const diskRows = diskLayout.map(d => ({
    Model: d.name || 'N/A', Brand: d.vendor || 'N/A', Type: d.type || 'N/A',
    'Size (GB)': (d.size / 1073741824).toFixed(1), Interface: d.interfaceType || 'N/A',
    Serial: d.serialNum && d.serialNum.length > 3 ? d.serialNum : 'N/A',
    Firmware: d.firmwareRevision || 'N/A', 'SMART Status': d.smartStatus || 'N/A',
  }));

  let batInfo = null;
  if (bat && bat.hasBattery) {
    batInfo = {
      'Has Battery': 'Yes', 'Current Charge': bat.percent != null ? bat.percent + '%' : 'N/A',
      'Charging Status': bat.isCharging ? 'Charging' : 'Discharging',
      'Design Capacity': bat.designedCapacity ? bat.designedCapacity + ' mWh' : 'N/A',
      'Present Capacity': bat.maxCapacity ? bat.maxCapacity + ' mWh' : 'N/A',
      'Cycle Count': bat.cycleCount != null ? String(bat.cycleCount) : 'N/A',
      'Time Remaining': bat.timeRemaining ? Math.floor(bat.timeRemaining / 60) + 'h ' + (bat.timeRemaining % 60) + 'm' : 'N/A',
      'Battery Model': bat.model || 'N/A', 'Battery Manufacturer': bat.manufacturer || 'N/A',
      'Battery Type': bat.type || 'N/A', 'Voltage': bat.voltage ? bat.voltage + ' V' : 'N/A',
    };
  }

  const nicRows = (Array.isArray(networkIfaces) ? networkIfaces : [])
    .filter(n => n.mac && n.mac !== '00:00:00:00:00:00').slice(0, 10)
    .map(n => ({
      Name: n.iface || n.ifaceName || 'N/A', Type: n.type || 'N/A', MAC: n.mac || 'N/A',
      IPv4: n.ip4 || 'N/A', IPv6: n.ip6 || 'N/A',
      Speed: n.speed ? n.speed + ' Mbps' : 'N/A', Status: n.operstate || 'N/A',
    }));

  const gpuRows = graphics.controllers.map(g => ({
    Model: g.model || 'N/A', Vendor: g.vendor || 'N/A',
    'VRAM (MB)': g.vram != null ? String(g.vram) : 'N/A',
    Driver: g.driverVersion || 'N/A',
    Resolution: g.resolutionX ? `${g.resolutionX} x ${g.resolutionY}` : 'N/A',
  }));

  return {
    generated: new Date().toLocaleString('en-IN'), hostname,
    system: {
      'Host Name': hostname, Manufacturer: system.manufacturer || 'N/A',
      'Model / Series': system.model || 'N/A',
      'System Serial Number': system.serial && system.serial !== 'Default string' && system.serial.length > 3 ? system.serial : 'N/A',
      'OS Name': (osInfo.distro || osInfo.release) ? `${osInfo.distro || ''} ${osInfo.release || ''}`.trim() : 'N/A', 'OS Architecture': osInfo.arch || 'N/A',
      'OS Build': osInfo.build || 'N/A', 'System Uptime': uptime,
      'BIOS Vendor': bios.vendor || 'N/A', 'BIOS Version': bios.version || 'N/A', 'BIOS Date': formatBiosDate(bios.releaseDate) || 'N/A',
    },
    cpu: {
      'Processor': cpu.brand || ((cpu.manufacturer || cpu.model) ? `${cpu.manufacturer || ''} ${cpu.model || ''}`.trim() : 'N/A'),
      'Physical Cores': cpu.physicalCores != null ? String(cpu.physicalCores) : 'N/A', 'Logical Cores': cpu.cores != null ? String(cpu.cores) : 'N/A',
      'Base Speed (GHz)': cpu.speed != null ? String(cpu.speed) : 'N/A', 'Max Speed (GHz)': String(cpu.speedMax || 'N/A'),
      'Socket': cpu.socket || 'N/A',
      'L1 Cache': cpu.cache?.l1d ? (cpu.cache.l1d / 1024) + ' KB' : 'N/A',
      'L2 Cache': cpu.cache?.l2 ? (cpu.cache.l2 / 1024) + ' KB' : 'N/A',
      'L3 Cache': cpu.cache?.l3 ? (cpu.cache.l3 / 1048576).toFixed(1) + ' MB' : 'N/A',
    },
    ramSummary: {
      'Total Installed RAM': (totalRam / 1073741824).toFixed(0) + ' GB',
      'Number of Modules': String(memLayout.filter(m => m.size > 0).length),
    },
    ramRows, diskRows, gpuRows, nicRows, batInfo,
  };
}

// Safe shape returned when collectRichReportData_inner throws for any reason
// (unexpected si.* structure changes, OEM quirks, etc). Keeps Report/QR/Export
// features from crashing outright — they degrade to "N/A" instead.
function emptyReportData() {
  const hostname = os.hostname();
  const uptimeSec = os.uptime();
  const uptime = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;
  return {
    generated: new Date().toLocaleString('en-IN'), hostname,
    system: {
      'Host Name': hostname, Manufacturer: 'N/A', 'Model / Series': 'N/A',
      'System Serial Number': 'N/A', 'OS Name': 'N/A', 'OS Architecture': 'N/A',
      'OS Build': 'N/A', 'System Uptime': uptime,
      'BIOS Vendor': 'N/A', 'BIOS Version': 'N/A', 'BIOS Date': 'N/A',
    },
    cpu: {
      'Processor': 'N/A', 'Physical Cores': 'N/A', 'Logical Cores': 'N/A',
      'Base Speed (GHz)': 'N/A', 'Max Speed (GHz)': 'N/A', 'Socket': 'N/A',
      'L1 Cache': 'N/A', 'L2 Cache': 'N/A', 'L3 Cache': 'N/A',
    },
    ramSummary: { 'Total Installed RAM': 'N/A', 'Number of Modules': 'N/A' },
    ramRows: [], diskRows: [], gpuRows: [], nicRows: [], batInfo: null,
  };
}

async function collectRichReportData() {
  try {
    return await collectRichReportData_inner();
  } catch (e) {
    console.error('[pcsu] collectRichReportData failed, returning safe defaults:', e);
    return emptyReportData();
  }
}

safeHandle('export-report', async () => {
  try {
    const tout = (p) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))]);
    const [sysR, diskR, gfxR, memNow, procs] = await Promise.all([
      prewarmSysInfo(), prewarmDisk(), prewarmGraphics(),
      siSafe(si.mem(), 10000), siSafe(si.processes(), 10000),
    ]);
    let raw = sysR?._raw || null;
    if (!raw) {
      try {
        const [sys2, osI2, bios2, cpu2] = await Promise.all([siSafe(si.system()), siSafe(si.osInfo()), siSafe(si.bios()), siSafe(si.cpu())]);
        raw = { system: sys2, osInfo: osI2, bios: bios2, cpu: cpu2, memLayout: [] };
      } catch (_) { raw = {}; }
    }
    const system = raw.system || {}; const osInfo = raw.osInfo || {};
    const bios = raw.bios || {}; const cpu = raw.cpu || {};
    const mem = memNow || {}; const diskLayout = diskR?._rawDisks || [];
    const graphics = { controllers: gfxR?._rawControllers || [] };
    const procsSafe = procs || { all: 'N/A', list: [] };
    const ts = new Date().toLocaleString('en-IN');
    const uptimeSec = os.uptime();
    const uptime = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;
    let report = `PC Smart Utility - System Report\nGenerated: ${ts}\n${'═'.repeat(60)}\n\n`;
    report += `SYSTEM\nManufacturer : ${system.manufacturer || 'N/A'}\nModel        : ${system.model || 'N/A'}\n\n`;
    report += `OPERATING SYSTEM\nName  : ${(osInfo.distro || osInfo.release) ? `${osInfo.distro || ''} ${osInfo.release || ''}`.trim() : 'N/A'}\nArch  : ${osInfo.arch || 'N/A'}\nBuild : ${osInfo.build || 'N/A'}\n\n`;
    report += `PROCESSOR\nBrand      : ${cpu.brand || 'N/A'}\nCores      : ${cpu.cores ?? 'N/A'} (${cpu.physicalCores ?? 'N/A'} physical)\nBase Speed : ${cpu.speed ?? 'N/A'} GHz\nMax Speed  : ${cpu.speedMax || 'N/A'} GHz\n\n`;
    report += `MEMORY\nTotal : ${mem.total != null ? (mem.total / 1073741824).toFixed(1) : 'N/A'} GB\nFree  : ${mem.available != null ? (mem.available / 1073741824).toFixed(1) : 'N/A'} GB\nUsed  : ${mem.active != null ? (mem.active / 1073741824).toFixed(1) : 'N/A'} GB\n\n`;
    report += `BIOS\nVendor  : ${bios.vendor || 'N/A'}\nVersion : ${bios.version || 'N/A'}\nDate    : ${formatBiosDate(bios.releaseDate) || 'N/A'}\n\nSTORAGE\n`;
    diskLayout.forEach(d => { report += `  ${d.name || 'N/A'} - ${d.type || 'Unknown'}, ${d.size != null ? (d.size / 1073741824).toFixed(1) : 'N/A'} GB, ${d.interfaceType || 'N/A'}\n`; });
    report += `\nGPU\n`;
    graphics.controllers.forEach(g => { report += `  ${g.model || 'N/A'} - ${g.vram || '?'} MB VRAM, Driver: ${g.driverVersion || 'N/A'}\n`; });
    report += `\nRUNNING PROCESSES: ${procsSafe.all}\nUPTIME: ${uptime}\n\nTop 10 Processes by CPU:\n`;
    (procsSafe.list || []).filter(p => p.name).sort((a, b) => (b.cpu || 0) - (a.cpu || 0)).slice(0, 10).forEach(p => {
      report += `  ${p.name.padEnd(30)} CPU: ${(p.cpu ?? 0).toFixed(1)}%  RAM: ${((p.memRss ?? 0) / 1048576).toFixed(0)} MB
`;
    });
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow || undefined, {
      title: 'Save System Report',
      defaultPath: path.join(os.homedir(), 'Documents', `pc-report-${Date.now()}.txt`),
      filters: [{ name: 'Text File', extensions: ['txt'] }],
    });
    if (canceled || !filePath) return { ok: false, message: 'Cancelled.' };
    await fs.promises.writeFile(filePath, report, 'utf8');
    shell.showItemInFolder(filePath);
    return { ok: true, message: `Report saved: ${path.basename(filePath)}` };
  } catch (e) { return { ok: false, message: e.message }; }
});

safeHandle('copy-report-clipboard', async () => {
  try {
    // Use siSafe (OEM-aware timeout) — avoids hanging on Dell/OEM WMI stall during clipboard copy
    const [system, osInfo, cpu, mem] = await Promise.all([
      siSafe(si.system(), 6000), siSafe(si.osInfo(), 6000),
      siSafe(si.cpu(), 6000), siSafe(si.mem(), 6000),
    ]);
    let report = `PC Smart Utility Report - ${new Date().toLocaleString('en-IN')}\n`;
    report += `System: ${system.manufacturer} ${system.model}\nOS: ${osInfo.distro} ${osInfo.release} (${osInfo.arch})\n`;
    report += `CPU: ${cpu.brand} - ${cpu.cores} cores @ ${cpu.speed} GHz\n`;
    report += `RAM: ${(mem.total / 1073741824).toFixed(1)} GB total, ${(mem.available / 1073741824).toFixed(1)} GB free\n`;
    clipboard.writeText(report);
    return { ok: true, message: 'Report copied to clipboard.' };
  } catch (e) { return { ok: false, message: e.message }; }
});

safeHandle('run-disk-defrag', async () => {
  openTool('dfrgui');
  return { ok: true, message: 'Disk Optimizer opened.' };
});

safeHandle('export-output-txt', async (_, { filename, content }) => {
  try {
    const safe = (filename || 'output').replace(/[^a-zA-Z0-9\-_]/g, '_').substring(0, 50);
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow || undefined, {
      title: 'Save Output as Text',
      defaultPath: path.join(os.homedir(), 'Documents', `${safe}-${Date.now()}.txt`),
      filters: [{ name: 'Text File', extensions: ['txt'] }],
    });
    if (canceled || !filePath) return { ok: false, message: 'Cancelled.' };
    await fs.promises.writeFile(filePath, content, 'utf8');
    shell.showItemInFolder(filePath);
    return { ok: true, message: `Saved: ${path.basename(filePath)}` };
  } catch (e) { return { ok: false, message: e.message }; }
});

// ── Excel/PDF/Word builders (same as v18, unchanged - they work) ──────────
// [Keeping all buildXLSX, buildDOCX, buildReportHTML, packZip, xmlEsc]

function xmlEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function buildReportHTML(d) {
  const css = `*{margin:0;padding:0;box-sizing:border-box;}body{font-family:'Segoe UI',Arial,sans-serif;font-size:11px;color:#111;background:#fff;padding:20px;}h1{font-size:17px;font-weight:700;color:#1a1a2e;border-bottom:3px solid #1a1a2e;padding-bottom:6px;margin-bottom:4px;}.sub{font-size:10px;color:#555;margin-bottom:16px;}h2{font-size:12px;font-weight:700;background:#1a1a2e;color:#fff;padding:5px 8px;margin:14px 0 0 0;letter-spacing:.5px;}table{width:100%;border-collapse:collapse;margin-top:0;}th{background:#2d2d5e;color:#fff;font-weight:700;padding:5px 8px;text-align:left;border:2px solid #1a1a2e;font-size:10.5px;}td{padding:4px 8px;border:2px solid #333;vertical-align:top;}tr:nth-child(even) td{background:#f0f0f8;}.kv td:first-child{font-weight:700;width:38%;background:#e8e8f4;color:#1a1a2e;}.kv td:last-child{color:#111;}.footer{margin-top:18px;font-size:9px;color:#888;text-align:center;}`;
  const kv = (entries) => `<table class="kv">${entries.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
  const tbl = (rows) => {
    if (!rows.length) return '<p style="padding:4px 8px;color:#888;">No data</p>';
    const ths = Object.keys(rows[0]).map(k => `<th>${k}</th>`).join('');
    const trs = rows.map(r => `<tr>${Object.values(r).map(v => `<td>${v}</td>`).join('')}</tr>`).join('');
    return `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
  };
  let html = `<h1>PC Smart Utility - System Report</h1><div class="sub">Generated: ${d.generated} &nbsp;|&nbsp; Host: ${d.hostname}</div>`;
  html += `<h2>SYSTEM INFORMATION</h2>${kv(Object.entries(d.system))}`;
  html += `<h2>PROCESSOR</h2>${kv(Object.entries(d.cpu))}`;
  html += `<h2>MEMORY (RAM)</h2>${kv(Object.entries(d.ramSummary))}${d.ramRows.length ? tbl(d.ramRows) : ''}`;
  html += `<h2>STORAGE DRIVES</h2>${tbl(d.diskRows)}`;
  html += `<h2>GRAPHICS / GPU</h2>${tbl(d.gpuRows)}`;
  html += `<h2>NETWORK ADAPTERS</h2>${tbl(d.nicRows)}`;
  if (d.batInfo) html += `<h2>BATTERY</h2>${kv(Object.entries(d.batInfo))}`;
  html += `<div class="footer">PC Smart Utility by OmixStudios | ${d.generated}</div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${html}</body></html>`;
}

function packZip(files) {
  const entries = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const dataBytes = Buffer.from(content, 'utf8');
    let crc = 0xFFFFFFFF;
    for (const b of dataBytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0); }
    crc = (crc ^ 0xFFFFFFFF) >>> 0;
    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0); localHeader.writeUInt16LE(20, 4); localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8); localHeader.writeUInt16LE(0, 10); localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14); localHeader.writeUInt32LE(dataBytes.length, 18);
    localHeader.writeUInt32LE(dataBytes.length, 22); localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); nameBytes.copy(localHeader, 30);
    entries.push({ name: nameBytes, data: dataBytes, crc, offset, localHeader });
    offset += localHeader.length + dataBytes.length;
  }
  const cdParts = [];
  for (const e of entries) {
    const cd = Buffer.alloc(46 + e.name.length);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(e.crc, 16); cd.writeUInt32LE(e.data.length, 20); cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(e.name.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(e.offset, 42);
    e.name.copy(cd, 46); cdParts.push(cd);
  }
  const cd = Buffer.concat(cdParts); const cdOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(cdOffset, 16); eocd.writeUInt16LE(0, 20);
  const parts = [];
  for (const e of entries) { parts.push(e.localHeader); parts.push(e.data); }
  parts.push(cd); parts.push(eocd);
  return Buffer.concat(parts);
}

function buildXLSX(rows) {
  const strings = []; const strIdx = {};
  const si2 = (s) => { const key = String(s ?? ''); if (!(key in strIdx)) { strIdx[key] = strings.length; strings.push(key); } return strIdx[key]; };
  const cols = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const cellXML = (col, rowNum, cell) => {
    if (!cell || cell.v === undefined || cell.v === '') return '';
    const v = String(cell.v); const idx = si2(v);
    const ref = `${col}${rowNum}`;
    let style = 0;
    if (cell.t === 'header') style = 1; else if (cell.t === 'thead') style = 2; else if (cell.t === 'key') style = 3; else style = 4;
    return `<c r="${ref}" t="s" s="${style}"><v>${idx}</v></c>`;
  };
  let sheetRows = '';
  rows.forEach((row, ri) => {
    if (!row || !row.length) return;
    const rowNum = ri + 1; let cells = '';
    row.forEach((cell, ci) => { if (ci >= cols.length) return; cells += cellXML(cols[ci], rowNum, cell); });
    if (cells) sheetRows += `<row r="${rowNum}">${cells}</row>`;
  });
  const sst = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">\n${strings.map(s => `<si><t xml:space="preserve">${xmlEsc(s)}</t></si>`).join('\n')}\n</sst>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\n<fonts count="5"><font><sz val="11"/><name val="Segoe UI"/><color rgb="FF111111"/></font><font><b/><sz val="13"/><name val="Segoe UI"/><color rgb="FFFFFFFF"/></font><font><b/><sz val="10.5"/><name val="Segoe UI"/><color rgb="FFFFFFFF"/></font><font><b/><sz val="11"/><name val="Segoe UI"/><color rgb="FF1a1a2e"/></font><font><sz val="11"/><name val="Segoe UI"/><color rgb="FF111111"/></font></fonts>\n<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1a1a2e"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2d2d5e"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFe8e8f4"/></patternFill></fill></fills>\n<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="medium"><color rgb="FF1a1a2e"/></left><right style="medium"><color rgb="FF1a1a2e"/></right><top style="medium"><color rgb="FF1a1a2e"/></top><bottom style="medium"><color rgb="FF1a1a2e"/></bottom></border></borders>\n<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>\n<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment wrapText="1"/></xf><xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment wrapText="1"/></xf><xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment wrapText="1"/></xf></cellXfs>\n</styleSheet>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetView workbookViewId="0"><selection activeCell="A1"/></sheetView><cols><col min="1" max="1" width="32" customWidth="1"/><col min="2" max="2" width="42" customWidth="1"/><col min="3" max="8" width="22" customWidth="1"/></cols><sheetData>${sheetRows}</sheetData></worksheet>`;
  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="System Report" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  return packZip({'[Content_Types].xml': contentTypes,'_rels/.rels': rels,'xl/workbook.xml': wb,'xl/_rels/workbook.xml.rels': wbRels,'xl/worksheets/sheet1.xml': sheet,'xl/sharedStrings.xml': sst,'xl/styles.xml': styles});
}

function buildDOCX(d) {
  const border = `<w:top w:val="single" w:sz="12" w:space="0" w:color="1a1a2e"/><w:left w:val="single" w:sz="12" w:space="0" w:color="1a1a2e"/><w:bottom w:val="single" w:sz="12" w:space="0" w:color="1a1a2e"/><w:right w:val="single" w:sz="12" w:space="0" w:color="1a1a2e"/>`;
  const cell = (text, isHeader = false, width = 4000) => {
    const shade = isHeader ? `<w:shd w:val="clear" w:color="auto" w:fill="1a1a2e"/>` : `<w:shd w:val="clear" w:color="auto" w:fill="e8e8f4"/>`;
    const color = isHeader ? `<w:color w:val="FFFFFF"/>` : `<w:color w:val="111111"/>`;
    const bold = isHeader ? `<w:b/>` : '';
    return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:tcBorders>${border}</w:tcBorders>${shade}</w:tcPr><w:p><w:pPr><w:spacing w:before="60" w:after="60"/></w:pPr><w:r><w:rPr>${bold}${color}<w:sz w:val="18"/><w:szCs w:val="18"/><w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI"/></w:rPr><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p></w:tc>`;
  };
  const kvRow = (k, v) => `<w:tr><w:trPr><w:trHeight w:val="320" w:hRule="atLeast"/></w:trPr>${cell(k, false, 3800)}${cell(v, false, 5200)}</w:tr>`;
  const thRow = (cols) => { const w = Math.floor(9000 / cols.length); return `<w:tr><w:trPr><w:trHeight w:val="340" w:hRule="atLeast"/></w:trPr>${cols.map(c => cell(c, true, w)).join('')}</w:tr>`; };
  const tdRow = (vals) => { const w = Math.floor(9000 / vals.length); return `<w:tr><w:trPr><w:trHeight w:val="300" w:hRule="atLeast"/></w:trPr>${vals.map(v => cell(String(v ?? 'N/A'), false, w)).join('')}</w:tr>`; };
  const h1 = (text) => `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:spacing w:before="240" w:after="80"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="1a1a2e"/><w:sz w:val="28"/><w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI"/></w:rPr><w:t>${xmlEsc(text)}</w:t></w:r></w:p>`;
  const h2 = (text) => `<w:p><w:pPr><w:spacing w:before="180" w:after="60"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="1a1a2e"/><w:sz w:val="22"/><w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI"/></w:rPr><w:t>${xmlEsc(text)}</w:t></w:r></w:p>`;
  const para = (text) => `<w:p><w:pPr><w:spacing w:before="60" w:after="60"/></w:pPr><w:r><w:rPr><w:color w:val="555555"/><w:sz w:val="18"/><w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI"/></w:rPr><w:t>${xmlEsc(text)}</w:t></w:r></w:p>`;
  const tbl = (rowsXml) => `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>${rowsXml}</w:tbl>`;
  const dynTbl = (dataRows) => {
    if (!dataRows.length) return '';
    const keys = Object.keys(dataRows[0]); const w = Math.floor(9000 / keys.length);
    const gridCols = keys.map(() => `<w:gridCol w:w="${w}"/>`).join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${gridCols}</w:tblGrid>${thRow(keys)}${dataRows.map(r => tdRow(Object.values(r))).join('')}</w:tbl>`;
  };
  let body = '';
  body += h1('PC Smart Utility - System Report');
  body += para(`Generated: ${d.generated}   |   Host: ${d.hostname}`);
  body += h2('SYSTEM INFORMATION'); body += tbl(Object.entries(d.system).map(([k, v]) => kvRow(k, v)).join(''));
  body += h2('PROCESSOR'); body += tbl(Object.entries(d.cpu).map(([k, v]) => kvRow(k, v)).join(''));
  body += h2('MEMORY (RAM)'); body += tbl(Object.entries(d.ramSummary).map(([k, v]) => kvRow(k, v)).join(''));
  if (d.ramRows.length) body += dynTbl(d.ramRows);
  body += h2('STORAGE DRIVES'); body += dynTbl(d.diskRows);
  body += h2('GRAPHICS / GPU'); body += dynTbl(d.gpuRows);
  body += h2('NETWORK ADAPTERS'); body += dynTbl(d.nicRows);
  if (d.batInfo) { body += h2('BATTERY'); body += tbl(Object.entries(d.batInfo).map(([k, v]) => kvRow(k, v)).join('')); }
  body += para('PC Smart Utility by OmixStudios');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>`;
  const docRels2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const docStyles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI"/><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:color w:val="1a1a2e"/><w:sz w:val="28"/></w:rPr></w:style></w:styles>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  return packZip({'[Content_Types].xml': contentTypes,'_rels/.rels': rels,'word/document.xml': document,'word/_rels/document.xml.rels': docRels2,'word/styles.xml': docStyles});
}

safeHandle('export-report-excel', async () => {
  try {
    const d = await collectRichReportData();
    const rows = [];
    const addHeader = (text) => rows.push([{ v: text, t: 'header' }]);
    const addRow = (k, v) => rows.push([{ v: k, t: 'key' }, { v: String(v ?? 'N/A'), t: 'val' }]);
    const addTableHeader = (cols) => rows.push(cols.map(c => ({ v: c, t: 'thead' })));
    const addTableRow = (cells) => rows.push(cells.map(c => ({ v: String(c ?? 'N/A'), t: 'trow' })));
    const addBlank = () => rows.push([]);
    addHeader('PC Smart Utility - System Report'); addRow('Generated', d.generated); addBlank();
    addHeader('SYSTEM INFORMATION'); Object.entries(d.system).forEach(([k, v]) => addRow(k, v)); addBlank();
    addHeader('PROCESSOR'); Object.entries(d.cpu).forEach(([k, v]) => addRow(k, v)); addBlank();
    addHeader('MEMORY (RAM)'); Object.entries(d.ramSummary).forEach(([k, v]) => addRow(k, v)); addBlank();
    if (d.ramRows.length) { addTableHeader(Object.keys(d.ramRows[0])); d.ramRows.forEach(r => addTableRow(Object.values(r))); addBlank(); }
    addHeader('STORAGE DRIVES');
    if (d.diskRows.length) { addTableHeader(Object.keys(d.diskRows[0])); d.diskRows.forEach(r => addTableRow(Object.values(r))); } addBlank();
    addHeader('GRAPHICS / GPU');
    if (d.gpuRows.length) { addTableHeader(Object.keys(d.gpuRows[0])); d.gpuRows.forEach(r => addTableRow(Object.values(r))); } addBlank();
    addHeader('NETWORK ADAPTERS');
    if (d.nicRows.length) { addTableHeader(Object.keys(d.nicRows[0])); d.nicRows.forEach(r => addTableRow(Object.values(r))); } addBlank();
    if (d.batInfo) { addHeader('BATTERY'); Object.entries(d.batInfo).forEach(([k, v]) => addRow(k, v)); }
    const xlsx = buildXLSX(rows);
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow || undefined, {
      title: 'Save Report as Excel',
      defaultPath: path.join(os.homedir(), 'Documents', `pc-report-${Date.now()}.xlsx`),
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });
    if (canceled || !filePath) return { ok: false, message: 'Cancelled.' };
    await fs.promises.writeFile(filePath, xlsx);
    shell.showItemInFolder(filePath);
    return { ok: true, message: `Excel report saved: ${path.basename(filePath)}` };
  } catch (e) { return { ok: false, message: e.message }; }
});

safeHandle('export-report-pdf', async () => {
  let pdfWin = null;
  try {
    const d = await collectRichReportData();
    const html = buildReportHTML(d);
    pdfWin = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false } });
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    await pdfWin.loadURL(dataUrl);
    await new Promise(r => setTimeout(r, 800));
    let pdfData;
    try {
      pdfData = await pdfWin.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 } });
    } finally {
      if (pdfWin && !pdfWin.isDestroyed()) { try { pdfWin.destroy(); } catch (_) {} }
      pdfWin = null;
    }
    if (!pdfData || !pdfData.length) return { ok: false, message: 'PDF generation produced no data.' };
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow || undefined, {
      title: 'Save Report as PDF',
      defaultPath: path.join(os.homedir(), 'Documents', `pc-report-${Date.now()}.pdf`),
      filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { ok: false, message: 'Cancelled.' };
    await fs.promises.writeFile(filePath, pdfData);
    shell.showItemInFolder(filePath);
    return { ok: true, message: `PDF report saved: ${path.basename(filePath)}` };
  } catch (e) {
    if (pdfWin && !pdfWin.isDestroyed()) { try { pdfWin.destroy(); } catch (_) {} }
    return { ok: false, message: e.message };
  }
});

safeHandle('export-report-word', async () => {
  try {
    const d = await collectRichReportData();
    const docx = buildDOCX(d);
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow || undefined, {
      title: 'Save Report as Word Document',
      defaultPath: path.join(os.homedir(), 'Documents', `pc-report-${Date.now()}.docx`),
      filters: [{ name: 'Word Document', extensions: ['docx'] }],
    });
    if (canceled || !filePath) return { ok: false, message: 'Cancelled.' };
    await fs.promises.writeFile(filePath, docx);
    shell.showItemInFolder(filePath);
    return { ok: true, message: `Word report saved: ${path.basename(filePath)}` };
  } catch (e) { return { ok: false, message: e.message }; }
});

// ── Pure-JS QR + Code128 Barcode HTML builder ─────────────────────────────
function buildQRBarcodeHTML(qrText, barcodeText, d) {
  // ── Code128 Barcode (pure JS, no library) ────────────────────────────────
  function encodeCode128(text) {
    const C128B = [
      ' ','!','"','#','$','%','&',"'",'(',')','*','+',',','-','.','/','0','1','2','3','4','5','6','7','8','9',':',';','<','=','>','?',
      '@','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z',
      '[','\\',']','^','_','`','a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v','w','x','y','z',
      '{','|','}','~',
    ];
    // Code128B patterns (11 bits each)
    const PATTERNS = [
      '11011001100','11001101100','11001100110','10010011000','10010001100','10001001100','10011001000','10011000100','10001100100','11001001000',
      '11001000100','11000100100','10110011100','10011011100','10011001110','10111001100','10011101100','10011100110','11001110010','11001011100',
      '11001001110','11011100100','11001110100','11101101110','11101001100','11100101100','11100100110','11101100100','11100110100','11100110010',
      '11011011000','11011000110','11000110110','10100011000','10001011000','10001000110','10110001000','10001101000','10001100010','11010001000',
      '11000101000','11000100010','10110111000','10110001110','10001101110','10111011000','10111000110','10001110110','11101110110','11010001110',
      '11000101110','11011101000','11011100010','11011101110','11101011000','11101000110','11100010110','11101101000','11101100010','11100011010',
      '11101111010','11001000010','11110001010','10100110000','10100001100','10010110000','10010000110','10000101100','10000100110','10110010000',
      '10110000100','10011010000','10011000010','10000110100','10000110010','11000010010','11001010000','11110111010','11000010100','10001111010',
      '10100111100','10010111100','10010011110','10111100100','10011110100','10011110010','11110100100','11110010100','11110010010','11011011110',
      '11011110110','11110110110','10101111000','10100011110','10001011110','10111101000','10111100010','11110101000','11110100010','10111011110',
      '10111101110','11101011110','11110101110','11010000100','11010010000','11010011100','1100011101011',
    ];
    // START B = index 104, STOP = index 106
    const startB = 104;
    const stopPat = '1100011101011';
    const chars = text.split('').map(c => {
      const idx = C128B.indexOf(c);
      return idx >= 0 ? idx : 0;
    });
    let checksum = startB;
    chars.forEach((v, i) => { checksum += v * (i + 1); });
    checksum = checksum % 103;
    const bars = PATTERNS[startB] + chars.map(c => PATTERNS[c]).join('') + PATTERNS[checksum] + stopPat;
    return bars;
  }

  function barcodeSVG(text, _width, height) {
    const bars = encodeCode128(text.replace(/[^\x20-\x7E]/g, '').slice(0, 48));
    const NARROW = 2, QUIET = 20;
    const totalW = bars.length * NARROW + QUIET * 2;
    let rects = ''; let x = QUIET; let i = 0;
    while (i < bars.length) {
      const bit = bars[i]; let run = 1;
      while (i + run < bars.length && bars[i + run] === bit) run++;
      const bw = run * NARROW;
      if (bit === '1') rects += `<rect x="${x}" y="0" width="${bw}" height="${height}" fill="#000"/>`;
      x += bw; i += run;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${height}" viewBox="0 0 ${totalW} ${height}"><rect width="${totalW}" height="${height}" fill="#fff"/>${rects}</svg>`;
  }

  // ── Micro QR using qr-svg approach (Reed-Solomon, pure JS) ───────────────
  // We use a compact URL-safe approach: encode as a data URI link QR
  function buildQRMatrix(text) {
    // Version 3, Error Correction L — supports ~127 chars
    // We use a simpler method: build the QR pattern via a compact table approach
    // For full reliability we generate it as a unicode block art embedded in the page
    // and also as a proper SVG via the QR algorithm below

    // Simple Reed-Solomon GF(256) QR encoder - Version 1-4
    const QR = (() => {
      const gf_exp = new Uint8Array(512);
      const gf_log = new Uint8Array(256);
      let x = 1;
      for (let i = 0; i < 255; i++) {
        gf_exp[i] = x; gf_log[x] = i;
        x = x << 1; if (x & 0x100) x ^= 0x11d;
      }
      for (let i = 255; i < 512; i++) gf_exp[i] = gf_exp[i - 255];
      const gfMul = (a, b) => a && b ? gf_exp[(gf_log[a] + gf_log[b]) % 255] : 0;
      const gfPoly = (n) => {
        let g = [1];
        for (let i = 0; i < n; i++) {
          const ng = new Array(g.length + 1).fill(0);
          for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j+1] ^= gfMul(g[j], gf_exp[i]); }
          g = ng;
        }
        return g;
      };
      const rsEncode = (data, nsym) => {
        const gen = gfPoly(nsym);
        const msg = [...data, ...new Array(nsym).fill(0)];
        for (let i = 0; i < data.length; i++) {
          const c = msg[i];
          if (c) for (let j = 1; j < gen.length; j++) msg[i+j] ^= gfMul(gen[j], c);
        }
        return msg.slice(data.length);
      };

      // Version 2 (25x25), EC level M, byte mode
      const SIZE = 25; // version 2
      const EC_CODEWORDS = 22;
      const DATA_CODEWORDS = 44 - EC_CODEWORDS; // 22 data

      function makeMatrix(text) {
        const bytes = [];
        for (let i = 0; i < text.length && i < 20; i++) bytes.push(text.charCodeAt(i));
        // Mode indicator (byte=0100) + char count + data + terminator
        const bits = [];
        const push = (v, n) => { for (let i = n-1; i >= 0; i--) bits.push((v >> i) & 1); };
        push(0b0100, 4); push(bytes.length, 8);
        bytes.forEach(b => push(b, 8));
        push(0, 4); // terminator
        while (bits.length % 8) bits.push(0);
        const codewords = [];
        for (let i = 0; i < bits.length; i += 8) codewords.push(parseInt(bits.slice(i,i+8).join(''),2));
        const pads = [0xEC, 0x11];
        while (codewords.length < DATA_CODEWORDS) codewords.push(pads[(codewords.length - DATA_CODEWORDS % 2) % 2]);
        const ec = rsEncode(codewords.slice(0, DATA_CODEWORDS), EC_CODEWORDS);
        const allCw = [...codewords.slice(0, DATA_CODEWORDS), ...ec];
        const allBits = [];
        allCw.forEach(cw => { for (let i = 7; i >= 0; i--) allBits.push((cw >> i) & 1); });

        const mat = Array.from({length: SIZE}, () => new Array(SIZE).fill(-1));
        // Finder patterns
        const finder = (r, c) => {
          for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
            const nr = r+dr, nc = c+dc;
            if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
            const inSquare = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
            const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
            const inInner  = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
            if (inSquare) mat[nr][nc] = (onBorder || inInner) ? 1 : 0;
          }
        };
        finder(0,0); finder(0,SIZE-7); finder(SIZE-7,0);
        // Timing
        for (let i = 8; i < SIZE-8; i++) { if (mat[6][i] < 0) mat[6][i] = i%2===0?1:0; if (mat[i][6] < 0) mat[i][6] = i%2===0?1:0; }
        // Dark module
        mat[SIZE-8][8] = 1;
        // Place data bits with mask 0
        let bi = 0;
        const isFunc = (r,c) => {
          if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return true;
          if (r < 9 && c < 9) return true;
          if (r < 9 && c > SIZE-9) return true;
          if (r > SIZE-9 && c < 9) return true;
          if (r === 6 || c === 6) return true;
          if (r === SIZE-8 && c === 8) return true;
          return false;
        };
        for (let c = SIZE-1; c > 0; c -= 2) {
          if (c === 6) c--;
          for (let r2 = SIZE-1; r2 >= 0; r2--) {
            for (let dc = 0; dc <= 1; dc++) {
              const cc = c - dc, rr = r2;
              if (!isFunc(rr, cc)) {
                const mask = (rr + cc) % 2 === 0;
                const bit = bi < allBits.length ? allBits[bi++] : 0;
                mat[rr][cc] = (bit ^ (mask ? 1 : 0));
              }
            }
          }
        }
        // Fill remaining -1
        for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (mat[r][c] < 0) mat[r][c] = 0;
        return mat;
      }
      return { makeMatrix, SIZE };
    })();

    return QR;
  }

  function qrSVG(text, pxSize) {
    const QR = buildQRMatrix(text);
    let shortText = text.slice(0, 18); // version 2 byte mode ~20 chars safe
    const mat = QR.makeMatrix(shortText);
    const S = QR.SIZE;
    const mod = pxSize / S;
    // Add 4-module quiet zone (required by QR spec for all camera apps)
    const QZ = 4; // quiet zone modules
    const totalMods = S + QZ * 2;
    const modSz = pxSize / totalMods;
    const qzPx = QZ * modSz;
    let cells = '';
    for (let r = 0; r < S; r++) for (let c = 0; c < S; c++) {
      if (mat[r][c]) cells += `<rect x="${(qzPx + c*modSz).toFixed(1)}" y="${(qzPx + r*modSz).toFixed(1)}" width="${modSz.toFixed(1)}" height="${modSz.toFixed(1)}" fill="#000"/>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${pxSize}" height="${pxSize}" viewBox="0 0 ${pxSize} ${pxSize}">
      <rect width="${pxSize}" height="${pxSize}" fill="#fff"/>
      ${cells}
    </svg>`;
  }

  // Build summary table rows HTML
  const css = `
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:'Segoe UI',Arial,sans-serif;font-size:11px;color:#111;background:#fff;padding:24px;}
    h1{font-size:18px;font-weight:800;color:#1a1a2e;border-bottom:3px solid #1a1a2e;padding-bottom:8px;margin-bottom:4px;}
    .sub{font-size:10px;color:#555;margin-bottom:20px;}
    h2{font-size:12px;font-weight:700;background:#1a1a2e;color:#fff;padding:5px 10px;margin:18px 0 0;}
    .codes-wrap{display:flex;gap:32px;align-items:flex-start;margin:18px 0;flex-wrap:wrap;}
    .code-box{display:flex;flex-direction:column;align-items:center;gap:8px;}
    .code-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#1a1a2e;text-align:center;}
    .code-caption{font-size:9px;color:#666;text-align:center;max-width:220px;word-break:break-all;}
    .save-btn{margin-top:4px;padding:5px 14px;background:#1a1a2e;color:#fff;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;letter-spacing:.03em;}
    .save-btn:hover{background:#2d2d5e;}
    .barcode-wrap{margin:0;}
    table{width:100%;border-collapse:collapse;margin-top:0;}
    th{background:#2d2d5e;color:#fff;font-weight:700;padding:5px 8px;text-align:left;border:1.5px solid #1a1a2e;font-size:10px;}
    td{padding:4px 8px;border:1.5px solid #333;vertical-align:top;}
    tr:nth-child(even) td{background:#f0f0f8;}
    .kv td:first-child{font-weight:700;width:36%;background:#e8e8f4;color:#1a1a2e;}
    .footer{margin-top:16px;font-size:9px;color:#888;text-align:center;border-top:1px solid #ddd;padding-top:8px;}
    .section-hint{font-size:9px;color:#888;font-style:italic;margin:3px 0 0 0;}
    .stat-bar{display:flex;gap:16px;flex-wrap:wrap;margin:12px 0;padding:10px 14px;background:#f5f5fc;border-radius:6px;border:1px solid #ddd;}
    .stat-item{display:flex;flex-direction:column;gap:2px;}
    .stat-key{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#666;}
    .stat-val{font-size:12px;font-weight:800;color:#1a1a2e;}
  `;

  const kv = (entries) => `<table class="kv">${entries.map(([k,v]) => `<tr><td>${k}</td><td>${v || 'N/A'}</td></tr>`).join('')}</table>`;

  // Use standalone proper encoder with full structured payload
  const _qrHost   = (d.hostname || 'N/A').slice(0,20);
  const _qrMfr    = (d.system['Manufacturer'] || 'N/A').slice(0,20);
  const _qrModel  = (d.system['Model / Series'] || 'N/A').slice(0,25);
  const _qrSerial = (d.system['System Serial Number'] || 'N/A').slice(0,25);
  const _qrMac    = ((d.nicRows||[]).find(n=>n.MAC&&n.MAC!=='00:00:00:00:00:00')||{}).MAC || 'N/A';
  const _qrCPU    = (d.cpu['Processor'] || 'N/A').slice(0,30);
  const _qrRAM    = (d.ramSummary['Total Installed RAM'] || 'N/A').slice(0,10);
  const _qrOS     = (d.system['OS Name'] || 'N/A').slice(0,20);
  const _pad = (k) => k.padEnd(6);
  const _qrPayload = ['[PC SMART UTILITY]',
    'Host='+_qrHost, 'Maker='+_qrMfr, 'Model='+_qrModel,
    'Serial='+_qrSerial, 'MAC='+_qrMac,
    'CPU='+_qrCPU, 'RAM='+_qrRAM, 'OS='+_qrOS].join('\n');
  const qrSvgStr = buildQRSVGFromText(_qrPayload, 180);
  const barSvgStr = barcodeSVG(barcodeText, 420, 60);
  _lastQRSvg  = qrSvgStr;
  _lastBarSvg = barSvgStr;

  const fullDataRows = [
    ...Object.entries(d.system),
    ['---CPU---',''],
    ...Object.entries(d.cpu),
    ['---RAM---',''],
    ...Object.entries(d.ramSummary),
    ...(d.ramRows.length ? d.ramRows.map((r,i) => [`RAM Slot ${i+1}`, Object.values(r).join(' | ')]) : []),
    ['---STORAGE---',''],
    ...d.diskRows.map((r,i) => [`Drive ${i+1}`, Object.values(r).join(' | ')]),
    ['---GPU---',''],
    ...d.gpuRows.map((r,i) => [`GPU ${i+1}`, Object.values(r).join(' | ')]),
    ['---NETWORK---',''],
    ...d.nicRows.map((r,i) => [`NIC ${i+1}`, Object.values(r).join(' | ')]),
    ...(d.batInfo ? [['---BATTERY---',''], ...Object.entries(d.batInfo)] : []),
  ];

  // Stats summary bar
  const statBar = `<div class="stat-bar">
    <div class="stat-item"><div class="stat-key">Manufacturer</div><div class="stat-val">${d.system['Manufacturer'] || 'N/A'}</div></div>
    <div class="stat-item"><div class="stat-key">Model</div><div class="stat-val">${d.system['Model / Series'] || 'N/A'}</div></div>
    <div class="stat-item"><div class="stat-key">Serial</div><div class="stat-val">${d.system['System Serial Number'] || 'N/A'}</div></div>
    <div class="stat-item"><div class="stat-key">OS</div><div class="stat-val">${d.system['OS Name'] || 'N/A'}</div></div>
    <div class="stat-item"><div class="stat-key">CPU</div><div class="stat-val">${d.cpu['Processor'] || 'N/A'}</div></div>
    <div class="stat-item"><div class="stat-key">RAM</div><div class="stat-val">${d.ramSummary['Total Installed RAM'] || 'N/A'}</div></div>
    <div class="stat-item"><div class="stat-key">Uptime</div><div class="stat-val">${d.system['System Uptime'] || 'N/A'}</div></div>
  </div>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
    <h1>PC Smart Utility — QR &amp; Barcode Report</h1>
    <div class="sub">Generated: ${d.generated} &nbsp;|&nbsp; Host: ${d.hostname} &nbsp;|&nbsp; By: OmixStudios</div>
    ${statBar}

    <h2>MACHINE IDENTITY CODES</h2>
    <div class="codes-wrap">
      <div class="code-box">
        <div class="code-label">📱 QR Code — Serial Number</div>
        <div id="qr-svg-wrap">${qrSvgStr}</div>
        <div class="code-caption">Scan: ${d.system['System Serial Number'] || d.hostname || 'N/A'}</div>
        <div class="section-hint">Scan with phone camera or any QR app</div>
        <button class="save-btn">⬇ Save QR as PNG</button>
      </div>
      <div class="code-box" style="flex:1;align-items:flex-start;">
        <div class="code-label" style="align-self:center;">▌▌ Barcode (Code 128) — Full System ID</div>
        <div id="bar-svg-wrap" class="barcode-wrap">${barSvgStr}</div>
        <div class="code-caption" style="max-width:420px;text-align:left;">${barcodeText}</div>
        <div class="section-hint">Scan with barcode scanner or app — encodes Maker | Model | Serial | CPU | RAM</div>
        <button class="save-btn" style="align-self:flex-start">⬇ Save Barcode as PNG</button>
      </div>
    </div>

    <h2>COMPLETE SYSTEM DATA</h2>
    ${kv(fullDataRows.filter(([k,v]) => k && !k.startsWith('---')))}

    <div class="footer">PC Smart Utility by OmixStudios &nbsp;|&nbsp; ${d.generated}</div>

    <!-- Save PNG handled from main app renderer -->
  </body></html>`;

  return html;
}

// ── Generate QR SVG (full structured data) ───────────────────────────────────
// ── QR Code via Python (100% reliable, proven library) ───────────────────────
// Uses Python's qrcode library which is pre-installed on Windows via Python.
// Falls back to a "scan not available" placeholder if Python is absent.
// ── QR Code — bundled npm 'qrcode' library (no Python, no internet needed) ───
const _QRCode = require('qrcode');
function generateQRSvgAsync(text) {
  return new Promise((resolve, reject) => {
    _QRCode.toString(text, {
      type: 'svg',
      errorCorrectionLevel: 'M',  // Medium: survives minor print damage
      margin: 4,
      width: 300,
      color: { dark: '#000000', light: '#ffffff' }
    }, (err, svg) => {
      if (err) reject(err);
      else resolve(svg);
    });
  });
}

safeHandle('generate-qr-svg', async () => {
  try {
    const d = await collectRichReportData();
    // Primary MAC address (first physical adapter)
    const primaryNic = (d.nicRows || []).find(n => n.MAC && n.MAC !== '00:00:00:00:00:00') || {};
    const macAddress = primaryNic.MAC || 'N/A';
    // Build structured QR payload — all key identity fields, scannable from any device
    // Compact structured payload — fits QR v10 ECC-L (~271 bytes max)
    const host    = (d.hostname || 'N/A').slice(0, 20);
    const mfr     = (d.system['Manufacturer'] || 'N/A').slice(0, 20);
    const model   = (d.system['Model / Series'] || 'N/A').slice(0, 25);
    const serial  = (d.system['System Serial Number'] || 'N/A').slice(0, 25);
    const cpu     = (d.cpu['Processor'] || 'N/A').slice(0, 30);
    const ram     = (d.ramSummary['Total Installed RAM'] || 'N/A').slice(0, 10);
    const os      = (d.system['OS Name'] || 'N/A').slice(0, 20);
    // Build Storage= e.g. "512 GB + 1 TB" or "512 GB" for single drive
    const storageParts = (d.diskRows || []).map(disk => {
      const gb = parseFloat(disk['Size (GB)'] || 0);
      if (!gb) return null;
      if (gb >= 1000) return (gb / 1000).toFixed(1).replace(/\.0$/, '') + ' TB';
      return Math.round(gb) + ' GB';
    }).filter(Boolean);
    const storage = storageParts.length ? storageParts.join(' + ') : 'N/A';
    const qrPayload = [
      '[PC SMART UTILITY]',
      'Host='    + host,
      'Maker='   + mfr,
      'Model='   + model,
      'Serial='  + serial,
      'MAC='     + macAddress,
      'CPU='     + cpu,
      'RAM='     + ram,
      'Storage=' + storage,
      'OS='      + os,
    ].join('\n');
    const svg = await generateQRSvgAsync(qrPayload);
    return { ok: true, svg, qrPayload };
  } catch (e) { return { ok: false, message: e.message }; }
});

// ── Generate Barcode SVG (full structured identity) ──────────────────────────
safeHandle('generate-barcode-svg', async () => {
  try {
    const d = await collectRichReportData();
    const primaryNic = (d.nicRows || []).find(n => n.MAC && n.MAC !== '00:00:00:00:00:00') || {};
    const macAddress = (primaryNic.MAC || 'N/A').replace(/:/g, '');
    // Code128 max reliable length ~60 chars. Format: KEY:VALUE pairs separated by |
    const host   = (d.hostname || 'N/A').slice(0, 15);
    const model  = (d.system['Model / Series'] || 'N/A').slice(0, 14);
    const serial = (d.system['System Serial Number'] || 'N/A').slice(0, 20);
    const mac    = macAddress.slice(0, 12);
    const barcodeText = `Host:${host}|Serial:${serial}|MAC:${mac}`;
    const svg = buildBarcodeSVGFromText(barcodeText, 520, 80);
    return { ok: true, svg, label: barcodeText };
  } catch (e) { return { ok: false, message: e.message }; }
});

// ── Standalone SVG builders (used by generate-qr-svg / generate-barcode-svg) ─
// ── Proper QR SVG encoder — Version 1-10, ECC Level L, Byte Mode ─────────────
// Handles up to ~271 bytes. Automatically selects the correct QR version.
function buildQRSVGFromText(text, pxSize) {
  // UTF-8 encode
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) { bytes.push(c); }
    else if (c < 0x800) { bytes.push(0xC0|(c>>6), 0x80|(c&0x3F)); }
    else { bytes.push(0xE0|(c>>12), 0x80|((c>>6)&0x3F), 0x80|(c&0x3F)); }
  }
  // ECC-L capacity per version (bytes)
  const CAP_L = [0,17,32,53,78,106,134,154,192,230,271];
  let version = 1;
  while (version <= 10 && CAP_L[version] < bytes.length) version++;
  if (version > 10) version = 10; // clamp — trim data below

  // EC block params for ECC L, versions 1-10
  // [ecPerBlock, numBlocks1, dataPerBlock1, numBlocks2, dataPerBlock2]
  const EC_TABLE = [
    null,
    [7,1,19,0,0],[10,1,34,0,0],[15,1,55,0,0],[20,2,40,0,0],[26,2,64,0,0],
    [18,2,48,2,45],[20,4,36,0,0],[24,2,46,2,45],[30,3,43,1,41],[18,4,38,2,36]
  ];
  const [ecb, b1, d1, b2, d2] = EC_TABLE[version];
  const SIZE = version * 4 + 17;
  const totalData = b1*d1 + b2*d2;

  // Trim bytes to fit
  const safeBytes = bytes.slice(0, totalData - 3); // room for mode+len+term

  // Build data codewords
  const dataBits = [];
  const pushBits = (v, n) => { for (let i = n-1; i >= 0; i--) dataBits.push((v>>i)&1); };
  pushBits(0b0100, 4);
  pushBits(safeBytes.length, 8);
  safeBytes.forEach(b => pushBits(b, 8));
  pushBits(0, 4);
  while (dataBits.length % 8) dataBits.push(0);
  const dataCW = [];
  for (let i = 0; i < dataBits.length; i+=8) dataCW.push(parseInt(dataBits.slice(i,i+8).join(''),2));
  const pads = [0xEC,0x11];
  while (dataCW.length < totalData) dataCW.push(pads[dataCW.length%2]);

  // GF(256)
  const gf_exp = new Uint8Array(512), gf_log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) { gf_exp[i]=x; gf_log[x]=i; x=x<<1; if(x&0x100)x^=0x11d; }
  for (let i = 255; i < 512; i++) gf_exp[i]=gf_exp[i-255];
  const gfMul = (a,b) => a&&b ? gf_exp[(gf_log[a]+gf_log[b])%255] : 0;
  const gfPoly = n => { let g=[1]; for(let i=0;i<n;i++){const ng=new Array(g.length+1).fill(0); for(let j=0;j<g.length;j++){ng[j]^=g[j];ng[j+1]^=gfMul(g[j],gf_exp[i]);}g=ng;} return g;};
  const rsEncode = (data,nsym) => { const gen=gfPoly(nsym); const msg=[...data,...new Array(nsym).fill(0)]; for(let i=0;i<data.length;i++){const c=msg[i];if(c)for(let j=1;j<gen.length;j++)msg[i+j]^=gfMul(gen[j],c);} return msg.slice(data.length);};

  // Blocks
  const blocks = []; let pos = 0;
  for (let i = 0; i < b1; i++) { blocks.push(dataCW.slice(pos, pos+d1)); pos+=d1; }
  for (let i = 0; i < b2; i++) { blocks.push(dataCW.slice(pos, pos+d2)); pos+=d2; }
  const ecBlocks = blocks.map(b => rsEncode(b, ecb));

  // Interleave
  const interleaved = [];
  const maxD = Math.max(d1, d2||0);
  for (let i = 0; i < maxD; i++) blocks.forEach(b => { if(i<b.length) interleaved.push(b[i]); });
  for (let i = 0; i < ecb; i++) ecBlocks.forEach(b => interleaved.push(b[i]));

  const allBits = [];
  interleaved.forEach(cw => { for(let i=7;i>=0;i--) allBits.push((cw>>i)&1); });
  const remBitsTable = [0,0,7,7,7,7,7,0,0,0,0];
  for (let i = 0; i < (remBitsTable[version]||0); i++) allBits.push(0);

  // Matrix
  const mat = Array.from({length:SIZE}, ()=>new Int8Array(SIZE).fill(-1));
  const isF = Array.from({length:SIZE}, ()=>new Uint8Array(SIZE));

  // Finder
  const addFinder = (r,c) => {
    for(let dr=-1;dr<=7;dr++) for(let dc=-1;dc<=7;dc++){
      const nr=r+dr, nc=c+dc;
      if(nr<0||nr>=SIZE||nc<0||nc>=SIZE) continue;
      const ins=dr>=0&&dr<=6&&dc>=0&&dc<=6;
      const border=dr===0||dr===6||dc===0||dc===6;
      const inner=dr>=2&&dr<=4&&dc>=2&&dc<=4;
      if(ins){mat[nr][nc]=(border||inner)?1:0; isF[nr][nc]=1;}
    }
  };
  addFinder(0,0); addFinder(0,SIZE-7); addFinder(SIZE-7,0);

  // Alignment (v>=2)
  const AP = [[],[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,28,46],[6,32,50]];
  if (version >= 2) {
    const ap = AP[version];
    for(let i=0;i<ap.length;i++) for(let j=0;j<ap.length;j++){
      const ar=ap[i], ac=ap[j];
      if(isF[ar][ac]) continue;
      for(let dr=-2;dr<=2;dr++) for(let dc=-2;dc<=2;dc++){
        const v=(dr===0&&dc===0)||(Math.abs(dr)===2||Math.abs(dc)===2)?1:0;
        mat[ar+dr][ac+dc]=v; isF[ar+dr][ac+dc]=1;
      }
    }
  }

  // Timing
  for(let i=8;i<SIZE-8;i++){
    mat[6][i]=i%2===0?1:0; isF[6][i]=1;
    mat[i][6]=i%2===0?1:0; isF[i][6]=1;
  }

  // Dark module
  mat[SIZE-8][8]=1; isF[SIZE-8][8]=1;

  // Format info areas
  for(let i=0;i<9;i++){isF[8][i]=1;isF[i][8]=1;}
  isF[8][SIZE-8]=1;
  for(let i=SIZE-7;i<SIZE;i++){isF[8][i]=1;isF[i][8]=1;}

  // Version info (v>=7)
  if(version>=7){
    for(let i=0;i<6;i++) for(let j=SIZE-11;j<SIZE-8;j++){isF[i][j]=1;isF[j][i]=1;}
  }

  // Place data bits with mask 0: (i+j)%2==0
  let bi=0;
  for(let c=SIZE-1;c>0;c-=2){
    if(c===6)c--;
    for(let r2=SIZE-1;r2>=0;r2--){
      for(let dc=0;dc<=1;dc++){
        const cc=c-dc, rr=r2;
        if(!isF[rr][cc]){
          const maskBit=(rr+cc)%2===0?1:0;
          const bit=bi<allBits.length?allBits[bi++]:0;
          mat[rr][cc]=bit^maskBit;
        }
      }
    }
  }

  // Format string: ECC-L + mask 0 = bits 101000000101101 (with XOR mask 101010000010010)
  // Pre-computed: ECC L (01) + mask 0 (000) -> format data 01000 -> with BCH -> 010000000101101 -> XOR 101010000010010 = 111010000111111
  const FMT_BITS = [1,1,1,0,1,1,1,1,1,0,0,0,1,0,0];
  for(let i=0;i<6;i++){mat[8][i]=FMT_BITS[i];mat[i][8]=FMT_BITS[14-i];}
  mat[8][7]=FMT_BITS[6]; mat[8][8]=FMT_BITS[7]; mat[7][8]=FMT_BITS[8];
  for(let i=9;i<15;i++) mat[14-i][8]=FMT_BITS[i];
  for(let i=0;i<8;i++) mat[8][SIZE-1-i]=FMT_BITS[i];
  for(let i=8;i<15;i++) mat[SIZE-15+i][8]=FMT_BITS[i];
  mat[SIZE-8][8]=1;

  // Build SVG with 4-module quiet zone for universal phone/camera scanning
  const QZ4 = 4; // ISO/IEC 18004 spec: minimum 4 modules quiet zone
  const totalQrMods = SIZE + QZ4 * 2;
  const mod = pxSize / totalQrMods;
  const qzPx = QZ4 * mod;
  let cells = '';
  for(let r=0;r<SIZE;r++) for(let c=0;c<SIZE;c++){
    if(mat[r][c]===1) cells+=`<rect x="${(qzPx + c*mod).toFixed(1)}" y="${(qzPx + r*mod).toFixed(1)}" width="${(mod+0.05).toFixed(2)}" height="${(mod+0.05).toFixed(2)}" fill="#000"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pxSize}" height="${pxSize}" viewBox="0 0 ${pxSize} ${pxSize}"><rect width="${pxSize}" height="${pxSize}" fill="#fff"/>${cells}</svg>`;
}

// ── Code 128B barcode SVG — fixed 2 px narrow bar for reliable scanning ──────
function buildBarcodeSVGFromText(text, _width, height) {
  const C128B = [
    ' ','!','"','#','$','%','&',"'",'(',')','*','+',',','-','.','/','0','1','2','3','4','5','6','7','8','9',':',';','<','=','>','?',
    '@','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z',
    '[','\\',']','^','_','`','a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v','w','x','y','z',
    '{','|','}','~',
  ];
  // Code 128B patterns — each symbol is exactly 11 modules; stop is 13
  const PATTERNS = [
    '11011001100','11001101100','11001100110','10010011000','10010001100','10001001100','10011001000','10011000100','10001100100','11001001000',
    '11001000100','11000100100','10110011100','10011011100','10011001110','10111001100','10011101100','10011100110','11001110010','11001011100',
    '11001001110','11011100100','11001110100','11101101110','11101001100','11100101100','11100100110','11101100100','11100110100','11100110010',
    '11011011000','11011000110','11000110110','10100011000','10001011000','10001000110','10110001000','10001101000','10001100010','11010001000',
    '11000101000','11000100010','10110111000','10110001110','10001101110','10111011000','10111000110','10001110110','11101110110','11010001110',
    '11000101110','11011101000','11011100010','11011101110','11101011000','11101000110','11100010110','11101101000','11101100010','11100011010',
    '11101111010','11001000010','11110001010','10100110000','10100001100','10010110000','10010000110','10000101100','10000100110','10110010000',
    '10110000100','10011010000','10011000010','10000110100','10000110010','11000010010','11001010000','11110111010','11000010100','10001111010',
    '10100111100','10010111100','10010011110','10111100100','10011110100','10011110010','11110100100','11110010100','11110010010','11011011110',
    '11011110110','11110110110','10101111000','10100011110','10001011110','10111101000','10111100010','11110101000','11110100010','10111011110',
    '10111101110','11101011110','11110101110','11010000100','11010010000','11010011100',
  ];
  const STOP_PAT = '1100011101011'; // 13 modules
  const startIdx = 104; // START B

  // Sanitise: only printable ASCII, max 48 chars (keeps PNG at reasonable width)
  const safeText = text.replace(/[^\x20-\x7E]/g, '').slice(0, 48);
  const charIdxs = safeText.split('').map(c => { const i = C128B.indexOf(c); return i >= 0 ? i : 0; });

  // Checksum
  let checksum = startIdx;
  charIdxs.forEach((v, i) => { checksum += v * (i + 1); });
  checksum = checksum % 103;

  // Assemble bit string
  const bits = PATTERNS[startIdx] + charIdxs.map(i => PATTERNS[i]).join('') + PATTERNS[checksum] + STOP_PAT;

  // FIXED narrow bar = 2 px — guarantees bars are thick enough for any scanner
  // Add 20 px quiet zone on each side (Code128 spec requires 10× narrow bar minimum)
  const NARROW = 2;
  const QUIET  = 20;
  const totalW = bits.length * NARROW + QUIET * 2;

  let rects = ''; let x = QUIET; let i = 0;
  while (i < bits.length) {
    const bit = bits[i]; let run = 1;
    while (i + run < bits.length && bits[i + run] === bit) run++;
    const barW = run * NARROW;
    if (bit === '1') rects += `<rect x="${x}" y="0" width="${barW}" height="${height}" fill="#000"/>`;
    x += barW;
    i += run;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${height}" viewBox="0 0 ${totalW} ${height}"><rect width="${totalW}" height="${height}" fill="#fff"/>${rects}</svg>`;
}

// ── Export QR as PNG image ───────────────────────────────────────────────────
safeHandle('export-qr-image', async (_, svgData) => {
  try {
    if (!svgData) return { ok: false, message: 'No QR data.' };
    let win2 = null;
    try {
      const htmlWrap = `<!DOCTYPE html><html><head><meta charset="utf-8">
        <style>
          *{margin:0;padding:0;box-sizing:border-box;}
          body{background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;
               width:480px;padding:24px;font-family:'Segoe UI',Arial,sans-serif;}
          .title{font-size:13px;font-weight:800;color:#1a1a2e;letter-spacing:.04em;margin-bottom:12px;text-align:center;}
          .qr-wrap{border:3px solid #1a1a2e;padding:12px;background:#fff;}
          svg{width:360px;height:360px;image-rendering:pixelated;display:block;}
          .hint{font-size:9px;color:#666;margin-top:10px;text-align:center;}
          .footer{font-size:8px;color:#aaa;margin-top:6px;}
        </style></head>
        <body>
          <div class="title">PC SMART UTILITY — QR CODE</div>
          <div class="qr-wrap">${svgData}</div>
          <div class="hint">Scan with phone camera or any QR reader to view system identity</div>
          <div class="footer">Contains: Host Name · Manufacturer · Model · Serial · MAC Address · OS</div>
        </body></html>`;
      win2 = new BrowserWindow({ width: 480, height: 520, show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false } });
      await win2.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlWrap));
      await new Promise(r => setTimeout(r, 700));
      const img = await win2.webContents.capturePage();
      const pngBuf = img.toPNG();
      const { filePath, canceled } = await dialog.showSaveDialog(mainWindow || undefined, {
        title: 'Save QR Code as Image',
        defaultPath: path.join(os.homedir(), 'Desktop', `pc-qr-${Date.now()}.png`),
        filters: [{ name: 'PNG Image', extensions: ['png'] }],
      });
      if (canceled || !filePath) return { ok: false, message: 'Cancelled.' };
      await fs.promises.writeFile(filePath, pngBuf);
      shell.showItemInFolder(filePath);
      return { ok: true, message: 'QR image saved to Desktop: ' + path.basename(filePath) };
    } finally {
      if (win2 && !win2.isDestroyed()) { try { win2.destroy(); } catch (_) {} }
    }
  } catch (e) { return { ok: false, message: e.message }; }
});

// ── Export Barcode as PNG image ───────────────────────────────────────────────
safeHandle('export-barcode-image', async (_, svgData) => {
  try {
    if (!svgData) return { ok: false, message: 'No barcode data.' };
    let win3 = null;
    try {
      // Extract label text from SVG comment if present, else show generic label
      const htmlWrap = `<!DOCTYPE html><html><head><meta charset="utf-8">
        <style>
          *{margin:0;padding:0;box-sizing:border-box;}
          body{background:#fff;display:flex;flex-direction:column;align-items:flex-start;
               padding:20px 24px;font-family:'Segoe UI',Arial,sans-serif;width:580px;}
          .title{font-size:12px;font-weight:800;color:#1a1a2e;letter-spacing:.04em;margin-bottom:10px;}
          .bar-wrap{border:2px solid #1a1a2e;padding:10px 10px 6px;background:#fff;width:100%;}
          svg{width:532px;height:80px;display:block;}
          .label{font-size:9px;color:#333;margin-top:8px;font-family:monospace;word-break:break-all;letter-spacing:.02em;}
          .hint{font-size:8px;color:#888;margin-top:6px;}
          .fields{font-size:8px;color:#555;margin-top:4px;}
        </style></head>
        <body>
          <div class="title">PC SMART UTILITY — BARCODE (Code 128)</div>
          <div class="bar-wrap">${svgData}</div>
          <div class="label" id="lbl">HOST | MODEL | SERIAL | MAC</div>
          <div class="fields">Fields: Host Name · System Model · System Serial Number · MAC Address</div>
          <div class="hint">Scan with any barcode scanner or app</div>
        </body></html>`;
      win3 = new BrowserWindow({ width: 580, height: 210, show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false } });
      await win3.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlWrap));
      await new Promise(r => setTimeout(r, 600));
      const img = await win3.webContents.capturePage();
      const pngBuf = img.toPNG();
      const { filePath, canceled } = await dialog.showSaveDialog(mainWindow || undefined, {
        title: 'Save Barcode as Image',
        defaultPath: path.join(os.homedir(), 'Desktop', `pc-barcode-${Date.now()}.png`),
        filters: [{ name: 'PNG Image', extensions: ['png'] }],
      });
      if (canceled || !filePath) return { ok: false, message: 'Cancelled.' };
      await fs.promises.writeFile(filePath, pngBuf);
      shell.showItemInFolder(filePath);
      return { ok: true, message: 'Barcode image saved to Desktop: ' + path.basename(filePath) };
    } finally {
      if (win3 && !win3.isDestroyed()) { try { win3.destroy(); } catch (_) {} }
    }
  } catch (e) { return { ok: false, message: e.message }; }
});

// ── System Health Score ───────────────────────────────────────────────────────────────────────────
safeHandle('get-health-score', async () => {
  try {
    const tout = (p) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))]);
    const cpuLoad = getCpuLoadFast(); // zero-WMI os.cpus() delta — never hangs
    const [mem, fsSize, bat, cpuTemp] = await Promise.all([
      siSafe(si.mem(), 6000), getFsSizeCached(), prewarmBattery().catch(() => null),
      siSafe(si.cpuTemperature(), 5000).catch(() => null),
    ]);
    const scores = {}; const issues = [];
    const cpuPct = cpuLoad.currentLoad || 0;
    if (cpuPct < 30)       { scores.cpu = 25; }
    else if (cpuPct < 60)  { scores.cpu = 18; issues.push({ icon: '⚡', text: `CPU usage is ${cpuPct.toFixed(0)}% - some processes are consuming resources.`, severity: 'warn' }); }
    else if (cpuPct < 85)  { scores.cpu = 10; issues.push({ icon: '🔥', text: `CPU is under heavy load (${cpuPct.toFixed(0)}%) - check running processes.`, severity: 'bad' }); }
    else                   { scores.cpu = 3;  issues.push({ icon: '🚨', text: `CPU is critically loaded (${cpuPct.toFixed(0)}%) - close unnecessary apps immediately.`, severity: 'bad' }); }

    // CPU Temperature
    const mainTemp = cpuTemp?.main ?? null;
    let tempScore = 10; // default: assume ok
    let tempVal = mainTemp !== null ? `${mainTemp}°C` : 'N/A';
    if (mainTemp !== null) {
      if (mainTemp > 95)     { tempScore = 2;  issues.push({ icon: '🌡️', text: `CPU temperature is critically high (${mainTemp}°C) - check cooling immediately.`, severity: 'bad' }); }
      else if (mainTemp > 85){ tempScore = 5;  issues.push({ icon: '🌡️', text: `CPU is running hot (${mainTemp}°C) - ensure good airflow.`, severity: 'warn' }); }
      else if (mainTemp > 70){ tempScore = 8;  }
      else                   { tempScore = 10; }
    }
    scores.cpuTemp = tempScore;

    const ramPct = mem.total > 0 ? (mem.active / mem.total) * 100 : 0;
    if (ramPct < 50)       { scores.ram = 25; }
    else if (ramPct < 70)  { scores.ram = 18; }
    else if (ramPct < 85)  { scores.ram = 10; issues.push({ icon: '🧠', text: `RAM usage is high (${ramPct.toFixed(0)}%) - consider closing unused applications.`, severity: 'warn' }); }
    else                   { scores.ram = 3;  issues.push({ icon: '🚨', text: `RAM is nearly full (${ramPct.toFixed(0)}%) - system may be slow or unstable.`, severity: 'bad' }); }
    const seen = new Set();
    const drives = fsSize.filter(d => d.size > 500 * 1024 * 1024).filter(d => { const k = d.fs || d.mount; if (seen.has(k)) return false; seen.add(k); return true; });
    let diskScore = 30;
    for (const d of drives) {
      const usedPct = d.size > 0 ? (d.used / d.size) * 100 : 0;
      const label = d.fs || d.mount;
      if (usedPct > 95)      { diskScore = Math.min(diskScore, 5);  issues.push({ icon: '💾', text: `Drive ${label} is critically full (${usedPct.toFixed(0)}% used) - free up space urgently.`, severity: 'bad' }); }
      else if (usedPct > 85) { diskScore = Math.min(diskScore, 15); issues.push({ icon: '💾', text: `Drive ${label} is nearly full (${usedPct.toFixed(0)}% used) - consider cleaning up files.`, severity: 'warn' }); }
      else if (usedPct > 70) { diskScore = Math.min(diskScore, 22); }
    }
    scores.disk = diskScore;
    if (bat && bat.hasBattery) {
      const pct = bat.percent || 0;
      if (pct > 50)       { scores.battery = 20; }
      else if (pct > 20)  { scores.battery = 14; issues.push({ icon: '🔋', text: `Battery at ${pct}% - consider plugging in soon.`, severity: 'warn' }); }
      else                { scores.battery = 5;  issues.push({ icon: '🔋', text: `Battery critically low (${pct}%) - plug in immediately.`, severity: 'bad' }); }
    } else { scores.battery = 20; }
    const uptimeDays = os.uptime() / 86400;
    if (uptimeDays < 3)       { scores.uptime = 10; }
    else if (uptimeDays < 7)  { scores.uptime = 7;  issues.push({ icon: '🔄', text: `System has been running for ${Math.floor(uptimeDays)} days - consider restarting to clear memory.`, severity: 'info' }); }
    else                      { scores.uptime = 3;  issues.push({ icon: '🔄', text: `System uptime is ${Math.floor(uptimeDays)} days - a restart is recommended for performance and updates.`, severity: 'warn' }); }

    // Startup impact: count via registry — hard-capped at 4s (OEM registry can be slow)
    let startupCount = 0;
    try {
      const regOut = await Promise.race([
        safeExec(
          `powershell -NoProfile -NonInteractive -Command "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -EA SilentlyContinue).PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | Measure-Object | Select -ExpandProperty Count"`,
          { timeout: _HW_TIER === 0 ? 8000 : _HW_TIER === 1 ? 5000 : 3000 }
        ),
        new Promise(res => setTimeout(() => res({ ok: false, out: '0', err: 'timeout' }), _HW_TIER === 0 ? 9000 : _HW_TIER === 1 ? 5500 : 3500))
      ]);
      startupCount = parseInt((regOut?.out || '').trim()) || 0;
    } catch (_) {}
    let startupScore = 10;
    if (startupCount > 15)     { startupScore = 2;  issues.push({ icon: '🚀', text: `${startupCount} startup apps detected — slow boot likely. Disable unused startup entries.`, severity: 'bad' }); }
    else if (startupCount > 10){ startupScore = 5;  issues.push({ icon: '🚀', text: `${startupCount} startup apps — consider disabling some to speed up boot.`, severity: 'warn' }); }
    scores.startup = startupScore;

    const MAX_SCORE = 130; // 25+10+25+30+20+10+10
    const rawTotal = Object.values(scores).reduce((a, b) => a + b, 0);
    const total = Math.min(100, Math.round((rawTotal / MAX_SCORE) * 100));
    const grade = total >= 90 ? 'A+' : total >= 80 ? 'A' : total >= 70 ? 'B' : total >= 55 ? 'C' : total >= 40 ? 'D' : 'F';
    const summary = total >= 90 ? 'Excellent - your PC is in great shape!' : total >= 80 ? 'Good - your PC is running well.' : total >= 70 ? 'Fair - a few things could be improved.' : total >= 55 ? 'Poor - your PC needs attention.' : 'Critical - immediate action required.';
    if (issues.length === 0) issues.push({ icon: '✅', text: 'No issues detected - your system is healthy!', severity: 'good' });

    // Build ALL drive breakdown entries
    const diskBreakdownEntries = {};
    drives.forEach((d, i) => {
      const label = d.fs || d.mount || `Drive ${i+1}`;
      const usedPct = d.size > 0 ? (d.used / d.size * 100).toFixed(0) : '0';
      diskBreakdownEntries[`disk_${i}`] = { score: Math.round(scores.disk / Math.max(1, drives.length)), max: Math.round(30 / Math.max(1, drives.length)), label: `Disk (${label})`, value: `${usedPct}% used` };
    });
    if (drives.length === 0) diskBreakdownEntries['disk_0'] = { score: scores.disk, max: 30, label: 'Disk Space', value: 'N/A' };

    const result = {
      ok: true, total, grade, summary, scores, issues,
      breakdown: {
        cpu:     { score: scores.cpu,     max: 25, label: 'CPU Load',        value: cpuPct.toFixed(1) + '%' },
        cpuTemp: { score: scores.cpuTemp, max: 10, label: 'CPU Temperature', value: tempVal },
        ram:     { score: scores.ram,     max: 25, label: 'RAM Usage',       value: ramPct.toFixed(1) + '%' },
        ...diskBreakdownEntries,
        battery: { score: scores.battery, max: 20, label: bat && bat.hasBattery ? 'Battery' : 'Power (Desktop)', value: bat && bat.hasBattery ? bat.percent + '%' : 'AC Power' },
        uptime:  { score: scores.uptime,  max: 10, label: 'Uptime',         value: Math.floor(os.uptime() / 3600) + 'h ' + Math.floor((os.uptime() % 3600) / 60) + 'm' },
        startup: { score: scores.startup, max: 10, label: 'Startup Impact', value: startupCount + ' apps' },
      },
    };
    _healthCache = result; _healthCacheTs = Date.now();
    return result;
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Quick Links ───────────────────────────────────────────────────────────
const QL_FILE = path.join(app.getPath('userData'), 'quick-links.json');

safeHandle('load-quick-links', async () => {
  try {
    const accessible = await fs.promises.access(QL_FILE).then(() => true).catch(() => false);
    if (accessible) {
      const raw = await fs.promises.readFile(QL_FILE, 'utf8');
      return { ok: true, data: JSON.parse(raw) };
    }
  } catch (_) {}
  return { ok: true, data: { categories: [] } };
});

safeHandle('save-quick-links', async (_, data) => {
  try {
    // Renderer data is untrusted: enforce a bounded, JSON-safe payload.
    if (data === undefined || data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: 'Invalid quick-links data.' };
    }
    const json = JSON.stringify(data);
    if (json.length > 1024 * 1024) return { ok: false, error: 'Quick-links data is too large.' };
    await fs.promises.writeFile(QL_FILE, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

safeHandle('export-quick-links', async (_, json) => {
  try {
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow || undefined, {
      title: 'Export Quick Links',
      defaultPath: path.join(os.homedir(), 'Documents', `quick-links-backup-${Date.now()}.json`),
      filters: [{ name: 'JSON File', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false };
    await fs.promises.writeFile(filePath, json, 'utf8');
    shell.showItemInFolder(filePath);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

safeHandle('import-quick-links', async () => {
  try {
    const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow || undefined, {
      title: 'Import Quick Links',
      filters: [{ name: 'JSON File', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return { ok: false, json: null };
    const json = await fs.promises.readFile(filePaths[0], 'utf8');
    return { ok: true, json };
  } catch (e) { return { ok: false, json: null }; }
});

// Open any https/http URL in default browser — for Quick Links (security-hardened)
function isSafeExternalUrl(url) {
  try {
    const p = new URL(url);
    if (p.protocol !== 'https:' && p.protocol !== 'http:') return false;
    const h = p.hostname.toLowerCase();
    // Block private/local IP ranges and loopback
    if (/^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|::1$|0\.0\.0\.0)/.test(h)) return false;
    // Block obviously non-public hostnames (no dot = local name)
    if (!h.includes('.')) return false;
    return true;
  } catch (_) { return false; }
}

ipcMain.on('open-external-url', (event, url) => {
  if (!url) return;
  if (isSafeExternalUrl(url)) {
    shell.openExternal(url).catch(() => {});
  } else {
    // Notify renderer of blocked URL
    try { event.sender.send('url-blocked', url); } catch (_) {}
  }
});

// ── First-run flag ────────────────────────────────────────────────────────
safeHandle('check-first-run', async () => {
  try {
    const flagPath = path.join(app.getPath('userData'), 'first-run-done.flag');
    const exists = await fs.promises.access(flagPath).then(() => true).catch(() => false);
    if (exists) return { firstRun: false };
    await fs.promises.writeFile(flagPath, '1', 'utf8');
    // Auto-enable autostart on first run — required for tray notifications when app is closed
    _setAutostartEnabled(true).catch(() => {});
    return { firstRun: true };
  } catch (_) { return { firstRun: false }; }
});

// ── Auto-start with Windows ───────────────────────────────────────────────
// ── Auto-start with Windows ───────────────────────────────────────────────
// Two mechanisms depending on build type:
//   NSIS installer  → Electron's setLoginItemSettings (HKCU Run registry)
//   APPX/Store      → Windows Task Scheduler (registry is sandboxed in MSIX)
// Detection: APPX exe lives inside WindowsApps folder (read-only, sandboxed).
const _IS_APPX = app.getPath('exe').toLowerCase().includes('windowsapps');
const _AUTOSTART_TASK = 'PcSmartUtilityAutostart';

async function _getAutostartEnabled() {
  if (_IS_APPX) {
    try {
      const r = await safeExec(
        `powershell -NoProfile -NonInteractive -Command "$t=Get-ScheduledTask -TaskName '${_AUTOSTART_TASK}' -EA SilentlyContinue; if($t){'true'}else{'false'}"`,
        { timeout: 5000 }
      );
      return (r.out || '').trim() === 'true';
    } catch (_) { return false; }
  } else {
    try {
      return app.getLoginItemSettings({ args: ['--silent'] }).openAtLogin;
    } catch (_) { return false; }
  }
}

async function _setAutostartEnabled(enable) {
  if (_IS_APPX) {
    const exePath = app.getPath('exe').replace(/'/g, "''");
    if (enable) {
      const psBase = `$a=New-ScheduledTaskAction -Execute '${exePath}' -Argument '--silent'; $t=New-ScheduledTaskTrigger -AtLogOn; $s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -MultipleInstances IgnoreNew; $p=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive`;
      const psLimited = `${psBase} -RunLevel Limited; Register-ScheduledTask -TaskName '${_AUTOSTART_TASK}' -Action $a -Trigger $t -Settings $s -Principal $p -Force -EA SilentlyContinue`;
      await safeExec(`powershell -NoProfile -NonInteractive -Command "${psLimited}"`, { timeout: 10000 });
      // Verify registration actually succeeded; -EA SilentlyContinue can swallow failures
      let ok = await _getAutostartEnabled();
      if (!ok) {
        // Retry without -RunLevel Limited — some sandbox/policy configs reject it
        const psPlain = `${psBase}; Register-ScheduledTask -TaskName '${_AUTOSTART_TASK}' -Action $a -Trigger $t -Settings $s -Principal $p -Force -EA SilentlyContinue`;
        await safeExec(`powershell -NoProfile -NonInteractive -Command "${psPlain}"`, { timeout: 10000 });
        ok = await _getAutostartEnabled();
      }
      return ok;
    } else {
      await safeExec(`powershell -NoProfile -NonInteractive -Command "Unregister-ScheduledTask -TaskName '${_AUTOSTART_TASK}' -Confirm:$false -EA SilentlyContinue"`, { timeout: 8000 });
      return true;
    }
  } else {
    app.setLoginItemSettings({
      openAtLogin: enable,
      openAsHidden: true,
      args: ['--silent'],
    });
    return true;
  }
}

safeHandle('get-autostart', async () => {
  try { return { enabled: await _getAutostartEnabled() }; }
  catch (_) { return { enabled: false }; }
});

safeHandle('set-autostart', async (_, enable) => {
  try {
    const ok = await _setAutostartEnabled(enable);
    return { ok: true, enabled: ok };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Health score simple cache (5 min TTL) ─────────────────────────────────
let _healthCache = null; let _healthCacheTs = 0;
safeHandle('get-health-score-cached', async () => {
  if (_healthCache && (Date.now() - _healthCacheTs) < 5 * 60 * 1000) return _healthCache;
  _healthCache = null; // will be set by get-health-score
  return { ok: false, stale: true };
});

// ── Auto-Clean Scheduler ──────────────────────────────────────────────────
const PREFS_FILE = path.join(app.getPath('userData'), 'prefs.json');
// ── Prefs & Schedule: async-safe with in-memory cache ──────────────────────
// Tiny files, but called from scheduler tick — must never block event loop.
// We keep an in-memory mirror and flush async; reads always hit cache first.
let _prefsCache = null;
let _schedCache = null;

// Async prefs cache init — called once at startup, no sync I/O on hot paths
async function initPrefsCache() {
  if (_prefsCache !== null) return;
  try {
    const ok = await fs.promises.access(PREFS_FILE).then(() => true).catch(() => false);
    if (ok) {
      const raw = await fs.promises.readFile(PREFS_FILE, 'utf8').catch(() => null);
      _prefsCache = raw ? JSON.parse(raw) : {};
    } else {
      _prefsCache = {};
    }
  } catch (_) { _prefsCache = {}; }
}

async function initSchedCache() {
  if (_schedCache !== null) return;
  try {
    const ok = await fs.promises.access(SCHEDULE_FILE).then(() => true).catch(() => false);
    if (ok) {
      const raw = await fs.promises.readFile(SCHEDULE_FILE, 'utf8').catch(() => null);
      _schedCache = raw ? JSON.parse(raw) : null;
    }
  } catch (_) {}
  if (!_schedCache) _schedCache = { enabled: true, hour: 13, minute: 0, days: [], lastRan: null, cleanRecycleBin: true };
}

function loadPrefs() {
  // Always returns in-memory cache (initialized at startup) — never blocks
  if (_prefsCache === null) _prefsCache = {}; // safety: should have been init'd
  return _prefsCache;
}
function savePrefs(p) {
  _prefsCache = p;
  fs.promises.writeFile(PREFS_FILE, JSON.stringify(p, null, 2), 'utf8').catch(() => {});
}
safeHandle('get-pref',  async (_, key)  => { await initPrefsCache(); const p = loadPrefs(); return { ok: true, value: p[key] ?? null }; });
safeHandle('get-oem-info', () => ({ ok: true, oemSafeMode: _OEM_SAFE_MODE, isSlowDisk: _IS_SLOW_DISK, gpuCrashCount: _gpuCrashCount || 0 }));

// ── Error Log Viewer — read local crash log for in-app diagnostics ────────────
safeHandle('get-error-log', async () => {
  try {
    const logPath = path.join(os.homedir(), 'pc-smart-crash.log');
    const exists = await fs.promises.access(logPath).then(() => true).catch(() => false);
    if (!exists) return { ok: true, entries: [], logPath };
    const raw = (await fs.promises.readFile(logPath, 'utf8').catch(() => '')).trim();
    if (!raw) return { ok: true, entries: [], logPath };
    // Parse lines — each is [ISO timestamp] message
    const entries = raw.split('\n')
      .filter(Boolean)
      .slice(-50) // last 50 entries only
      .reverse()  // newest first
      .map(line => {
        const m = line.match(/^\[([^\]]+)\]\s*(.+)$/s);
        if (!m) return { ts: '', msg: line };
        return { ts: m[1], msg: m[2].trim() };
      });
    return { ok: true, entries, logPath, gpuCrashes: _gpuCrashCount || 0, oemSafe: _OEM_SAFE_MODE, slowDisk: _IS_SLOW_DISK };
  } catch (e) { return { ok: false, message: e.message }; }
});

safeHandle('clear-error-log', async () => {
  try {
    const logPath = path.join(os.homedir(), 'pc-smart-crash.log');
    await fs.promises.writeFile(logPath, '', 'utf8').catch(() => {});
    return { ok: true };
  } catch (e) { return { ok: false, message: e.message }; }
});

// ── Local Usage Analytics ─────────────────────────────────────────────────────
// 100% on-device. No internet. No account. No tracking.
// Writes events to pc-smart-analytics.json in user home dir.
// Purpose: Vinay can ask users "open Diagnostics" and see what's happening.
// Event schema: { event, section?, detail?, ts }
// Analytics file capped at 500 events — oldest dropped automatically.

const _ANALYTICS_FILE = path.join(os.homedir(), 'pc-smart-analytics.json');
const _ANALYTICS_MAX  = 500;

// In-memory analytics cache — eliminates sync readFileSync on every log-event IPC call
// (fires on every user action; sync disk I/O on HDD/OEM causes measurable UI jank)
let _analyticsCache = null;
let _analyticsDirty = false;
let _analyticsFlushTimer = null;

function _readAnalytics() {
  if (_analyticsCache !== null) return _analyticsCache;
  try {
    if (!fs.existsSync(_ANALYTICS_FILE)) { _analyticsCache = { events: [], meta: {} }; return _analyticsCache; }
    _analyticsCache = JSON.parse(fs.readFileSync(_ANALYTICS_FILE, 'utf8'));
    return _analyticsCache;
  } catch(_) { _analyticsCache = { events: [], meta: {} }; return _analyticsCache; }
}

function _writeAnalytics(data) {
  _analyticsCache = data;
  // Debounced async flush — batches rapid log-event calls into one write every 3s
  if (_analyticsFlushTimer) clearTimeout(_analyticsFlushTimer);
  _analyticsFlushTimer = setTimeout(() => {
    _analyticsFlushTimer = null;
    fs.promises.writeFile(_ANALYTICS_FILE, JSON.stringify(_analyticsCache, null, 0), 'utf8').catch(() => {});
  }, 3000);
}

safeHandle('log-event', (_, event, section, detail) => {
  try {
    const data = _readAnalytics();
    if (!Array.isArray(data.events)) data.events = [];
    data.events.push({
      e: event,
      ...(section ? { s: section } : {}),
      ...(detail  ? { d: String(detail).slice(0, 120) } : {}),
      t: Date.now(),
    });
    // Cap at max — drop oldest
    if (data.events.length > _ANALYTICS_MAX) {
      data.events = data.events.slice(-_ANALYTICS_MAX);
    }
    // Update meta counters
    if (!data.meta) data.meta = {};
    data.meta.totalEvents  = (data.meta.totalEvents  || 0) + 1;
    data.meta.lastSeen     = Date.now();
    data.meta.appVersion   = app.getVersion();
    data.meta.isOem        = _OEM_SAFE_MODE;
    data.meta.isSlowDisk   = _IS_SLOW_DISK;
    data.meta.platform     = process.platform;
    data.meta.arch         = process.arch;
    _writeAnalytics(data);
    return { ok: true };
  } catch(e) { return { ok: false }; }
});

safeHandle('get-analytics', async () => {
  try {
    const data = _readAnalytics();
    const events = data.events || [];

    // Build summary — section visit counts
    const sectionCounts = {};
    const eventCounts   = {};
    let   lastSection   = null;
    let   lastTs        = null;

    events.forEach(ev => {
      eventCounts[ev.e]  = (eventCounts[ev.e]  || 0) + 1;
      if (ev.s) sectionCounts[ev.s] = (sectionCounts[ev.s] || 0) + 1;
      if (ev.t > (lastTs || 0)) { lastTs = ev.t; lastSection = ev.s || ev.e; }
    });

    // Top sections sorted by visits
    const topSections = Object.entries(sectionCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    // Session count = number of app_open events
    const sessions = eventCounts['app_open'] || 0;

    // Share/rate funnel
    const shareSeen    = eventCounts['share_prompt_shown']  || 0;
    const shareClicked = eventCounts['share_clicked']        || 0;
    const rateSeen     = eventCounts['rate_prompt_shown']    || 0;
    const rateClicked  = eventCounts['rate_clicked']         || 0;

    // Clean stats
    const cleanRan   = eventCounts['clean_ran']   || 0;
    const cleanShare = eventCounts['clean_share_clicked'] || 0;

    // Cyber quiz stats
    const quizAnswered = eventCounts['quiz_answered'] || 0;
    const quizCorrect  = eventCounts['quiz_correct']  || 0;

    // Errors / timeouts
    const dashTimeout = eventCounts['dash_timeout']  || 0;
    const hwTimeout   = eventCounts['hw_timeout']    || 0;
    const qrFail      = eventCounts['qr_fail']       || 0;

    // Recent 20 raw events (newest first) for diagnostics
    const recent = events.slice(-20).reverse().map(ev => ({
      event:   ev.e,
      section: ev.s || null,
      detail:  ev.d || null,
      time:    ev.t ? new Date(ev.t).toLocaleString() : null,
    }));

    return {
      ok: true,
      meta: data.meta || {},
      summary: {
        sessions,
        topSections,
        shareFunnel:  { seen: shareSeen,  clicked: shareClicked },
        rateFunnel:   { seen: rateSeen,   clicked: rateClicked  },
        cleanStats:   { ran: cleanRan,    shareClicked: cleanShare },
        quizStats:    { answered: quizAnswered, correct: quizCorrect },
        timeouts:     { dashboard: dashTimeout, hardware: hwTimeout },
        errors:       { qrFail },
      },
      recent,
    };
  } catch(e) { return { ok: false, message: e.message }; }
});

safeHandle('clear-analytics', async () => {
  try {
    _writeAnalytics({ events: [], meta: {} });
    return { ok: true };
  } catch(e) { return { ok: false, message: e.message }; }
});
safeHandle('save-pref', async (_, key, value) => {
  await initPrefsCache();
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(key) ||
      key === '__proto__' || key === 'prototype' || key === 'constructor') {
    return { ok: false, error: 'Invalid preference key.' };
  }
  try {
    const encoded = JSON.stringify(value);
    if (encoded.length > 100 * 1024) return { ok: false, error: 'Preference value is too large.' };
  } catch (_) {
    return { ok: false, error: 'Preference value is not JSON-safe.' };
  }
  const p = loadPrefs();
  p[key] = value;
  savePrefs(p);
  return { ok: true };
});

const SCHEDULE_FILE = path.join(app.getPath('userData'), 'auto-clean-schedule.json');
let scheduleTimer = null;
let promptFiredMinute = -1;

function loadSchedule() {
  // Always returns in-memory cache (async-initialized at startup) — never blocks
  if (_schedCache === null) _schedCache = { enabled: true, hour: 13, minute: 0, days: [], lastRan: null, cleanRecycleBin: true };
  return { ..._schedCache, hour: 13, minute: 0 }; // time fixed at 1:00 PM
}

function saveSchedule(s) {
  const fixed = { ...s, hour: 13, minute: 0 }; // time fixed at 1:00 PM
  _schedCache = fixed;
  fs.promises.writeFile(SCHEDULE_FILE, JSON.stringify(fixed, null, 2), 'utf8').catch(() => {});
}

function shouldRunNow(s) {
  if (!s.enabled) return false;
  const now = new Date();
  if (s.days && s.days.length > 0) { if (!s.days.includes(now.getDay())) return false; }
  if (s.lastRan) { const last = new Date(s.lastRan); if (last.toDateString() === now.toDateString()) return false; }
  return true;
}

async function runAutoClean(opts = {}) {
  // Async chunked auto-clean — never blocks main process on OEM systems
  if (_cleanerRunning) return;
  pauseMonitoring(); // pause realtime before any disk I/O
  try {
    const cleanRecycleBin = opts.cleanRecycleBin !== false;
    const home = os.homedir();

    // Temp folders — chunked async
    const tempPaths = [...new Set([os.tmpdir(), path.join(home, 'AppData', 'Local', 'Temp')])];
    for (const tp of tempPaths) {
      await deleteFilesChunked(tp);
      await new Promise(r => setImmediate(r));
    }

    // Thumbnail cache
    const explorerDir = path.join(home, 'AppData', 'Local', 'Microsoft', 'Windows', 'Explorer');
    await deleteFilesChunked(explorerDir, item => item.startsWith('thumbcache_') && item.endsWith('.db'));
    await new Promise(r => setImmediate(r));

    // Recent files
    const recentPath = path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Recent');
    await deleteFilesChunked(recentPath, item => item.endsWith('.lnk'));
    await new Promise(r => setImmediate(r));

    // Recycle bin
    if (cleanRecycleBin) {
      await safeExec('powershell -NoProfile -NonInteractive -Command "Clear-RecycleBin -Force -ErrorAction SilentlyContinue"', { timeout: 15000 }).catch(() => {});
      await new Promise(r => setImmediate(r));
    }

    // Browser caches — chunked per profile folder
    const chromiumAutoUserDatas = [
      path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
      path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
      path.join(home, 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data'),
      path.join(home, 'AppData', 'Local', 'Vivaldi', 'User Data'),
      path.join(home, 'AppData', 'Local', 'Opera Software', 'Opera Stable'),
    ];
    const arcPath = await resolveArcUserDataPath(home);
    if (arcPath) chromiumAutoUserDatas.push(arcPath);
    const CACHE_SUBS = ['Cache', path.join('Cache','Cache_Data'), path.join('Code Cache','js'), path.join('Code Cache','wasm'), 'GPUCache'];
    for (const userDataDir of chromiumAutoUserDatas) {
      const accessible = await fs.promises.access(userDataDir).then(() => true).catch(() => false);
      if (!accessible) continue;
      let profiles = [];
      try {
        const entries = await fs.promises.readdir(userDataDir, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          if (e.isDirectory() && (e.name === 'Default' || /^Profile \d+$/.test(e.name))) {
            profiles.push(path.join(userDataDir, e.name));
          }
        }
      } catch (_) {}
      if (!profiles.length) profiles.push(path.join(userDataDir, 'Default'));
      for (const prof of profiles) {
        for (const sub of CACHE_SUBS) {
          const p = path.join(prof, sub);
          const ok = await fs.promises.access(p).then(() => true).catch(() => false);
          if (ok) await deleteFilesChunked(p);
        }
        await new Promise(r => setImmediate(r));
      }
    }
  } catch (_) {}
  finally { resumeMonitoring(); } // always resume, clears _cleanerRunning too
}

function _fireCleanPrompt() {
  const winVisible = mainWindow && !mainWindow.isDestroyed()
    && mainWindow.isVisible() && !mainWindow.isMinimized();

  if (Notification.isSupported()) {
    try {
      const n = new Notification({
        title: '🚀 Boost Your PC Performance',
        body: 'Clear temp & cache files now for a faster, smoother PC.',
        silent: false,
      });
      n.on('click', () => {
        _notifNavigate('cleaner');
        const w2 = BrowserWindow.getAllWindows()[0] || null;
        if (w2 && !w2.isDestroyed()) {
          const navDelay = _HW_TIER === 0 ? 1600 : _HW_TIER === 1 ? 1100 : 800;
          setTimeout(() => {
            if (w2 && !w2.isDestroyed() && w2.isVisible() && !w2.isMinimized()) {
              w2.webContents.send('auto-clean-prompt');
            }
          }, navDelay);
        }
      });
      n.show();
    } catch (_) {}
  }

  if (winVisible) {
    mainWindow.webContents.send('auto-clean-prompt');
  }
}

// In-process clean reminder: fires once per calendar day, triggered by app
// launch/login rather than a clock time — so it can never be missed by the
// PC being off or asleep at a specific hour. Task Scheduler (AtLogOn) backs
// this up when the app is fully closed.
const CLEAN_CHECK_MS = 30 * 60 * 1000; // safety-net recheck every 30 min
let _cleanIntervalTimer = null;

function _cleanDailyCheck() {
  try {
    const sc = loadSchedule();
    if (!sc.enabled) return;
    const todayKey = new Date().toISOString().slice(0, 10);
    if (_cleanLastFiredDay === todayKey) return; // already shown today

    // Keep at least a 4-hour gap from the quiz notification so users don't
    // get hit with both at once. If quiz hasn't fired yet today (or is
    // disabled), this check just retries every 30 min via the interval below.
    const qs = loadQuizSettings();
    if (qs.enabled) {
      const quizFiredToday = _quizLastFiredDay === todayKey;
      if (!quizFiredToday) return; // wait for quiz to fire first today
      const sinceQuiz = Date.now() - _quizLastFiredTs;
      if (sinceQuiz < 4 * 60 * 60 * 1000) return; // not yet 4 hours since quiz
    }

    _saveCleanLastFiredDay(todayKey);
    _fireCleanPrompt();
  } catch (_) {}
}

function startScheduler() {
  if (scheduleTimer) clearInterval(scheduleTimer);
  if (_cleanIntervalTimer) clearInterval(_cleanIntervalTimer);

  const s = loadSchedule();
  if (!s.enabled) return;

  setTimeout(_cleanDailyCheck, 15000); // staggered from quiz check, after boot settles
  _cleanIntervalTimer = setInterval(_cleanDailyCheck, CLEAN_CHECK_MS);
}

// ── Store version check ───────────────────────────────────────────────────────
const CURRENT_APP_VERSION = '5.8.7';
safeHandle('check-store-version', async () => {
  try {
    // Fetch MS Store product page and look for version string
    const res = await new Promise((resolve, reject) => {
      const https = require('https');
      const req = https.get(
        'https://apps.microsoft.com/detail/9NW5DMR2XQ36',
        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, timeout: 8000 },
        (res2) => {
          let data = '';
          res2.on('data', chunk => { data += chunk; if (data.length > 80000) req.destroy(); });
          res2.on('end', () => resolve(data));
        }
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });

    // Look for version pattern in Store page HTML
    const match = res.match(/"softwareVersion"\s*:\s*"([\d.]+)"/);
    if (!match) return { ok: true, updateAvailable: false };

    const storeVersion = match[1];
    const updateAvailable = _versionGt(storeVersion, CURRENT_APP_VERSION);
    return { ok: true, updateAvailable, storeVersion, currentVersion: CURRENT_APP_VERSION };
  } catch (_) {
    return { ok: true, updateAvailable: false };
  }
});

function _versionGt(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

safeHandle('get-schedule', () => loadSchedule());
safeHandle('save-schedule', (_, s) => {
  const fixed = { ...s, hour: 13, minute: 0 };
  saveSchedule(fixed);
  promptFiredMinute = -1;
  startScheduler();
  // Sync Windows Task Scheduler — always 1:00 PM
  if (fixed && fixed.enabled) { _registerCleanTask(fixed); }
  else { _unregisterCleanTask(); }
  return { ok: true };
});

let _autoCleanRunning = false;
safeHandle('run-auto-clean', async () => {
  if (_autoCleanRunning || _cleanerRunning) return { ok: false, error: 'Clean already in progress' };
  _autoCleanRunning = true;
  try {
    const s = loadSchedule();
    await runAutoClean({ cleanRecycleBin: s.cleanRecycleBin !== false });
    s.lastRan = new Date().toISOString();
    saveSchedule(s);
    return { ok: true };
  } finally { _autoCleanRunning = false; }
});

// ── Battery Report HTML — generates and opens the full powercfg HTML report ───
safeHandle('open-battery-report-html', async () => {
  try {
    const { execFile } = require('child_process');
    const reportPath = path.join(os.tmpdir(), 'pcsu_batteryreport_full.html');
    await fs.promises.unlink(reportPath).catch(() => {});

    await new Promise((resolve, reject) => {
      execFile('powercfg', ['/batteryreport', '/output', reportPath], { timeout: 25000 }, (err) => {
        if (err) reject(err); else resolve();
      });
    });

    const reportExists = await fs.promises.access(reportPath).then(() => true).catch(() => false);
    if (!reportExists) {
      return { ok: false, error: 'powercfg did not produce a report file. Make sure you are on a laptop with a battery.' };
    }
    await shell.openPath(reportPath);
    return { ok: true, path: reportPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Battery Report (powercfg /batteryreport — parses XML output) ──────────────
safeHandle('run-battery-report', async () => {
  try {
    const tmpXml = path.join(os.tmpdir(), 'pcsu_batteryreport.xml');
    // Remove stale file first
    await fs.promises.unlink(tmpXml).catch(() => {});

    const { execFile } = require('child_process');

    // Run powercfg with /xml flag for machine-readable output
    const runPowercfg = (args) => new Promise((resolve, reject) => {
      execFile('powercfg', args, { timeout: 20000 }, (err, stdout, stderr) => {
        if (err) reject(err); else resolve(stdout);
      });
    });

    let xmlContent = null;
    try {
      await runPowercfg(['/batteryreport', '/output', tmpXml, '/xml']);
      const exists = await fs.promises.access(tmpXml).then(() => true).catch(() => false);
      if (exists) xmlContent = await fs.promises.readFile(tmpXml, 'utf8').catch(() => null);
    } catch (_) {}

    // Fallback: HTML report
    let htmlContent = null;
    if (!xmlContent) {
      const tmpHtml = path.join(os.tmpdir(), 'pcsu_batteryreport.html');
      await fs.promises.unlink(tmpHtml).catch(() => {});
      try {
        await runPowercfg(['/batteryreport', '/output', tmpHtml]);
        const existsH = await fs.promises.access(tmpHtml).then(() => true).catch(() => false);
        if (existsH) htmlContent = await fs.promises.readFile(tmpHtml, 'utf8').catch(() => null);
      } catch (_) {}
    }

    const content = xmlContent || htmlContent || '';
    if (!content) return { ok: false, error: 'powercfg did not produce output. Run as standard user on a laptop with a battery.' };

    // ── XML parsing (preferred) ────────────────────────────────────────────────
    const xmlTag = (tag) => {
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, 'i');
      const m = content.match(re);
      return m ? m[1].replace(/<[^>]+>/g, '').trim() : null;
    };
    const xmlAttr = (tag, attr) => {
      const re = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, 'i');
      const m = content.match(re);
      return m ? m[1].trim() : null;
    };

    // ── Design / Full capacity ─────────────────────────────────────────────────
    // XML: <DesignCapacity>45000</DesignCapacity> and <FullChargeCapacity>38000</FullChargeCapacity>
    let designCap = xmlTag('DesignCapacity') || xmlTag('DESIGNCAPACITY');
    let fullCap   = xmlTag('FullChargeCapacity') || xmlTag('FULLCHARGECAPACITY');

    // HTML fallback — tables have "Design Capacity" / "Full Charge Capacity" as row headers
    if (!designCap) {
      const m = content.match(/Design\s+Capacity[\s\S]{0,400}?(\d[\d,]+)\s*m[Ww][Hh]/);
      if (m) designCap = m[1].replace(/,/g, '');
    }
    if (!fullCap) {
      const m = content.match(/Full\s+Charge\s+Capacity[\s\S]{0,400}?(\d[\d,]+)\s*m[Ww][Hh]/);
      if (m) fullCap = m[1].replace(/,/g, '');
    }

    // Also try: <Batteries><Battery>…<DesignedCapacity> (some Windows versions)
    if (!designCap) {
      const m = content.match(/DesignedCapacity[^>]*>(\d+)/i);
      if (m) designCap = m[1];
    }
    if (!fullCap) {
      const m = content.match(/FullChargedCapacity[^>]*>(\d+)/i) ||
                content.match(/LastFullChargeCapacity[^>]*>(\d+)/i);
      if (m) fullCap = m[1];
    }

    // ── Cycle count ────────────────────────────────────────────────────────────
    let cycleCnt = xmlTag('CycleCount') || xmlTag('CYCLECOUNT');
    if (!cycleCnt) {
      const m = content.match(/Cycle\s+Count[\s\S]{0,300}?<td[^>]*>(\d+)/i) ||
                content.match(/CycleCount[^>]*>(\d+)/i);
      if (m) cycleCnt = m[1];
    }

    // ── Manufacturer / chemistry / serial ─────────────────────────────────────
    let manufacturer = xmlTag('Manufacturer') || xmlTag('MANUFACTURER');
    let chemistry    = xmlTag('Chemistry')    || xmlTag('CHEMISTRY');
    let serial       = xmlTag('SerialNumber') || xmlTag('SERIALNUMBER');

    if (!manufacturer) {
      const m = content.match(/Manufacturer[\s\S]{0,200}?<td[^>]*>([^<]{2,60})<\/td>/i);
      if (m) manufacturer = m[1].trim();
    }
    if (!chemistry) {
      const m = content.match(/Chemistry[\s\S]{0,200}?<td[^>]*>([A-Z]{2,12})<\/td>/i);
      if (m) chemistry = m[1].trim();
    }

    // ── Health % ──────────────────────────────────────────────────────────────
    let healthPct = null;
    if (designCap && fullCap) {
      const d = parseInt(String(designCap).replace(/,/g, ''));
      const f = parseInt(String(fullCap).replace(/,/g, ''));
      if (d > 0 && f > 0) healthPct = Math.min(100, Math.round((f / d) * 100));
    }

    // ── Average drain ─────────────────────────────────────────────────────────
    let activeAverageDrain = null;
    const drainMatch = content.match(/ActiveAverageDrain[^>]*>(\d+)/i) ||
                       content.match(/Average\s+Active\s+Drain[\s\S]{0,300}?(\d[\d,]+)\s*m[Ww]/i);
    if (drainMatch) activeAverageDrain = drainMatch[1].replace(/,/g, '');

    // ── Estimated remaining ───────────────────────────────────────────────────
    // Use WMI as more reliable source for current charge
    let currentPct = null;
    try {
      const wmiOut = await new Promise((res) => {
        execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
          '(Get-CimInstance Win32_Battery -EA SilentlyContinue).EstimatedChargeRemaining'],
          { timeout: 5000 }, (err, out) => res(out || ''));
      });
      const pctVal = parseInt(wmiOut.trim());
      if (!isNaN(pctVal) && pctVal >= 0 && pctVal <= 100) currentPct = pctVal;
    } catch (_) {}

    const hasAnyData = designCap || fullCap || cycleCnt || manufacturer || chemistry;
    if (!hasAnyData) {
      return {
        ok: true, empty: true,
        currentPct,
        raw: content.substring(0, 500),
      };
    }

    return {
      ok: true,
      designCap: designCap ? String(designCap).replace(/,/g, '') : null,
      fullCap:   fullCap   ? String(fullCap).replace(/,/g, '')   : null,
      healthPct,
      cycleCnt,
      manufacturer,
      chemistry,
      serial,
      activeAverageDrain,
      currentPct,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});




safeHandle('generate-custom-qr', async (_, payload) => {
  try {
    if (!payload || typeof payload !== 'string') return { error: 'Invalid payload' };
    if (payload.length > 2000) return { error: 'Payload too long' };
    const svg = await new Promise((resolve, reject) => {
      _QRCode.toString(payload, {
        type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 280,
        color: { dark: '#000000', light: '#ffffff' }
      }, (err, s) => err ? reject(err) : resolve(s));
    });
    return { svg };
  } catch (e) { return { error: e.message || 'QR generation failed' }; }
});


// ─── QUIZ REMINDER SCHEDULER (main process — fires even when window hidden) ──
const QUIZ_SETTINGS_FILE = path.join(app.getPath('userData'), 'quiz-settings.json');

function loadQuizSettings() {
  if (_quizSettingsCache !== null) return { enabled: _quizSettingsCache.enabled !== false, hour: 17, minute: 0 };
  try {
    const raw = require('fs').readFileSync(QUIZ_SETTINGS_FILE, 'utf8');
    _quizSettingsCache = JSON.parse(raw);
    return { enabled: _quizSettingsCache.enabled !== false, hour: 17, minute: 0 };
  } catch(_) { _quizSettingsCache = { enabled: true, hour: 17, minute: 0 }; return _quizSettingsCache; }
}

function saveQuizSettingsFile(s) {
  _quizSettingsCache = s;
  fs.promises.writeFile(QUIZ_SETTINGS_FILE, JSON.stringify(s), 'utf8').catch(() => {});
}

let _quizSettingsCache = null;
let _quizNotifTimer = null;

let _quizLastFiredDay = null; // tracks date string 'YYYY-MM-DD' to prevent double-fire
let _quizLastFiredTs = 0;      // exact time it fired today — used to space out the cleaner reminder

// Persist quiz-fired-day across restarts so we don't double-fire on same day after reboot
const _QUIZ_FIRED_FILE = path.join(app.getPath('userData'), 'quiz-last-fired.json');
function _loadQuizLastFiredDay() {
  try {
    const raw = fs.readFileSync(_QUIZ_FIRED_FILE, 'utf8');
    const obj = JSON.parse(raw);
    _quizLastFiredDay = obj.day || null;
    _quizLastFiredTs = obj.ts || 0;
  } catch(_) {}
}
function _saveQuizLastFiredDay(day) {
  _quizLastFiredDay = day;
  _quizLastFiredTs = Date.now();
  fs.promises.writeFile(_QUIZ_FIRED_FILE, JSON.stringify({ day, ts: _quizLastFiredTs }), 'utf8').catch(() => {});
}
// Load persisted day at startup (sync — tiny file, called once before scheduleQuizNotification)
_loadQuizLastFiredDay();

// In-process quiz reminder: checks every 30 min while app is open, fires
// ONCE per calendar day at the scheduled time. Task Scheduler covers the
// same when the app is closed (_registerQuizTask), also exactly once/day.
const QUIZ_CHECK_MS = 30 * 60 * 1000; // safety-net recheck every 30 min in case launch-check was missed
let _quizIntervalTimer = null;

function _quizDailyCheck() {
  try {
    const qs = loadQuizSettings();
    if (!qs.enabled) return;
    const todayKey = new Date().toISOString().slice(0, 10);
    if (_quizLastFiredDay === todayKey) return; // already shown today
    _saveQuizLastFiredDay(todayKey);
    _fireQuizNotification();
  } catch (_) {}
}

function scheduleQuizNotification() {
  if (_quizNotifTimer) { clearTimeout(_quizNotifTimer); _quizNotifTimer = null; }
  if (_quizIntervalTimer) clearInterval(_quizIntervalTimer);
  const s = loadQuizSettings();
  if (!s.enabled) return;

  // Fire immediately if today hasn't been shown yet (covers: Windows login,
  // app launch, or tray process starting) — no clock-time wait, so it can never
  // be "missed" by the PC being off or asleep at a specific hour.
  setTimeout(_quizDailyCheck, 5000); // small delay so app finishes booting first
  _quizIntervalTimer = setInterval(_quizDailyCheck, QUIZ_CHECK_MS);
}

function _fireQuizNotification() {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: '🧠 Show Off Your Knowledge!',
      body: "Today's quiz is ready — keep your streak alive!",
      silent: false,
    });
    n.show();
    n.on('click', () => {
      _notifNavigate('cybersecurity');
    });
  } catch(_) {}
}

// ── Windows Task Scheduler for Quiz Reminder ──────────────────────────────────
// Registers a daily schtask so the quiz notification fires even when the app is
// fully closed.  MSIX builds use PowerShell toast XML (no exe launch needed).
// Non-APPX builds use the original exe-launch approach.
const QUIZ_TASK_NAME = 'PCSmartUtility_QuizReminder';

function _registerQuizTask() {
  _unregisterQuizTask();
  // Login-triggered: fires when Windows logs the user in, even when app was
  // fully closed. The in-app day-guard ensures it still only shows once/day.
  const exePath = app.getPath('exe').replace(/'/g, "''");
  const ps = [
    `$a = New-ScheduledTaskAction -Execute '${exePath}' -Argument '--quiz-notify --silent';`,
    `$t1 = New-ScheduledTaskTrigger -AtLogOn;`,
    `$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 4) -RepetitionDuration ([TimeSpan]::MaxValue);`,
    `$t3 = $null; try { $t3 = New-ScheduledTaskTrigger -SessionStateChange -StateChange SessionUnlock } catch { $t3 = $null };`,
    `$triggers = if ($t3) { @($t1,$t2,$t3) } else { @($t1,$t2) };`,
    `$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew -StartWhenAvailable:$true;`,
    `$p = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited;`,
    `Register-ScheduledTask -TaskName '${QUIZ_TASK_NAME}' -Action $a -Trigger $triggers -Settings $s -Principal $p -Force -EA Stop | Out-Null;`,
    `Write-Output 'OK';`,
  ].join(' ');
  const psB64 = Buffer.from(ps, 'utf16le').toString('base64');
  exec(`powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${psB64}`,
    { windowsHide: true, timeout: 12000 }, (err, stdout, stderr) => {
      _logTaskResult('quiz-register', err, stdout, stderr);
    });
}

function _unregisterQuizTask() {
  exec(`schtasks /Delete /F /TN "${QUIZ_TASK_NAME}"`, { windowsHide: true }, () => {});
}

safeHandle('quiz-settings-save', (_, settings) => {
  try { saveQuizSettingsFile({ enabled: settings.enabled !== false }); } catch(_) {}
  // Sync Windows Task Scheduler — every 12 hours repeating
  if (settings && settings.enabled) {
    _registerQuizTask();
  } else {
    _unregisterQuizTask();
  }
  scheduleQuizNotification(); // also keep in-process timer for when app IS running
  return { ok: true };
});

safeHandle('cyber-quiz-notify', (_, title, body) => {
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title: title || '🔒 PC Smart Utility', body: body || 'Daily Security Quiz Ready!', silent: false });
      n.show();
      n.on('click', () => { _notifNavigate('cybersecurity'); });
    }
  } catch(_) {}
  return { ok: true };
});
// ─────────────────────────────────────────────────────────────────────────────

// ── PC Diagnostic Report ──────────────────────────────────────────────────────
// Scans Windows Event Logs for the 12 most common user complaints.
// No admin, no C:\ writes — pure stdout JSON via PowerShell.
// Outputs: structured findings + plain-English solutions + AI-ready prompt.

safeHandle('get-diagnostic-report', async () => {
  try {
    const diagPS = `
$cutoff = (Get-Date).AddDays(-30)
$r = @{}

function Ev($log,$ids,$max=50,$filter='') {
  try {
    $evts = @(Get-WinEvent -FilterHashtable @{LogName=$log;Id=$ids} -MaxEvents $max -EA Stop |
      Where-Object { $_.TimeCreated -ge $cutoff } |
      ForEach-Object {
        $msg = ($_.Message -replace '[\r\n]+',' ').Substring(0,[Math]::Min(300,$_.Message.Length))
        if ($filter -eq '' -or $msg -match $filter) {
          @{ ts=$_.TimeCreated.ToString('yyyy-MM-dd HH:mm'); id=$_.Id;
             lvl=$_.LevelDisplayName; src=$_.ProviderName; msg=$msg }
        }
      } | Where-Object {$_ -ne $null})
    return $evts
  } catch { return @() }
}

# CRASH & FREEZE
$r.appCrashes   = Ev 'Application' @(1000) 60          # App crash (faulting module, exception code)
$r.appHangs     = Ev 'Application' @(1002) 40          # App hang / Not Responding
$r.bsod         = Ev 'Application' @(1001) 30 'BugCheck|bugcheck|0x00|BlueScreen'  # BSOD bugcheck
$r.wer          = Ev 'Application' @(1001,1026) 30     # Windows Error Reporting buckets

# SHUTDOWN & POWER
$r.shutdowns    = Ev 'System' @(41,6008) 50            # Unexpected shutdown / dirty boot
$r.cleanShut    = Ev 'System' @(1074,6006) 20          # Planned shutdown / restart (who/why)
$r.powerEvent   = Ev 'System' @(42,506,507) 20         # Sleep/wake failures, lid events

# DISK & STORAGE
$r.diskErrors   = Ev 'System' @(7,11,15,153,129,157) 60  # Bad sector, IO error, disk reset
$r.diskFull     = Ev 'System' @(2013) 10               # Volume out of space
$r.ntfs         = Ev 'System' @(55,50,130) 20          # NTFS corruption
$r.volmgr       = Ev 'System' @(46,161) 20             # Volume manager errors
$r.storport     = Ev 'System' @(129,143) 20            # Storport/NVMe reset

# DRIVER & HARDWARE
$r.driverLoad   = Ev 'System' @(219,7026) 30           # Driver failed to load at boot
$r.driverCrash  = Ev 'System' @(4101,4119) 30          # GPU driver reset (TDR), display driver
$r.pnp          = Ev 'System' @(20001,20003) 20        # PnP device install fail
$r.acpi         = Ev 'System' @(13,18) 20              # ACPI / firmware errors

# MEMORY & CPU
$r.memErrors    = Ev 'System' @(1001,18,19,17,20) 20  # WHEA, hardware memory errors
$r.thermal      = Ev 'System' @(37,19,203) 30          # Thermal throttle, temp sensor
$r.whea         = Ev 'System' @(1,17,18,19) 20         # WHEA corrected/uncorrected hardware errors
$r.cpuErr       = Ev 'System' @(56) 10                 # CPU machine check exception

# NETWORK
$r.networkDrop  = Ev 'System' @(4202,4204,10317) 40   # WiFi disconnect, adapter lost
$r.dnsErr       = Ev 'System' @(1014,1010) 20          # DNS resolution timeout
$r.dhcp         = Ev 'System' @(1001,1002,1003) 20    # DHCP failure / IP conflict
$r.netAdapter   = Ev 'System' @(27,32) 20              # Network adapter reset

# SECURITY
$r.loginFail    = Ev 'Security' @(4625) 30             # Failed login attempts
$r.loginSuccess = Ev 'Security' @(4624) 10             # Successful logins (audit)
$r.policyChange = Ev 'Security' @(4719,4902) 10        # Audit policy change
$r.firewall     = Ev 'Security' @(2003,2004,2009) 20   # Firewall rule change / blocked

# WINDOWS UPDATE & SYSTEM
$r.updateFail   = Ev 'System' @(20,24,25) 20           # CBS update failed / success
$r.sfc          = Ev 'System' @(4,12) 10               # SFC / component store corruption
$r.serviceCrash = Ev 'System' @(7034,7031,7032,7001) 30 # Service crashed / failed to start
$r.serviceHang  = Ev 'System' @(7022) 20               # Service hung on start
$r.eventlogErr  = Ev 'System' @(6,104) 10              # Event log cleared / errors

# BOOT & STARTUP
$r.bootErr      = Ev 'System' @(100,109,513) 10        # Boot performance degraded
$r.winlogon     = Ev 'Application' @(1511,1515,1518) 10 # Profile load failure
$r.startupSlow  = Ev 'Microsoft-Windows-Diagnostics-Performance/Operational' @(100,101,102,103) 10  # Boot/shutdown slow

# BATTERY & LAPTOP
$r.battery      = Ev 'System' @(26,27,104) 20          # Battery / power state change errors
$r.lid          = Ev 'System' @(506,507) 10            # Lid open/close events

# APPLICATION SPECIFIC
$r.dotnet       = Ev 'Application' @(1026,1023) 20     # .NET runtime crash
$r.officeErr    = Ev 'Application' @(2000,2001) 10     # Office crashes
$r.vsredist     = Ev 'Application' @(1000) 10 'VCRUNTIME|msvcp|msvcr|ucrtbase'  # VC++ runtime errors

# CERTIFICATES & TRUST
$r.certErr      = Ev 'System' @(5,6,11) 10             # Certificate / crypto errors

# HARDWARE SPECIFIC (Dell/HP/Lenovo OEM)
$r.oemHw        = Ev 'System' @(1,3,4,5) 20 'BIOS|firmware|SMBus|SMC|BMC|thermal|fan|sensor'

$r | ConvertTo-Json -Depth 3 -Compress
`    // Run the single combined PowerShell command — 45s timeout for slow systems
    const psResult = await safeExec(
      `powershell -NoProfile -NonInteractive -Command "${diagPS.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`,
      { timeout: 45000 }
    );

    let raw = {};
    try { raw = JSON.parse(psResult.out || '{}'); } catch (_) {}

    // ── Live system state (already have these fast) ──────────────────────────
    const uptimeSec  = os.uptime();
    const totalRam   = os.totalmem();
    const freeRam    = os.freemem();
    const ramPct     = Math.round(((totalRam - freeRam) / totalRam) * 100);
    const cpuLoad    = getCpuLoadFast();
    const fsData     = await getFsSizeCached();
    const cpuTemp    = await siSafe(si.cpuTemperature(), 5000).catch(() => null);
    const sysInfo    = await prewarmSysInfo().catch(() => null);

    // Startup app count from registry
    let startupCount = 0;
    try {
      const regR = await safeExec(
        `powershell -NoProfile -NonInteractive -Command "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -EA SilentlyContinue).PSObject.Properties | Where-Object {$_.Name -notlike 'PS*'} | Measure-Object | Select-Object -ExpandProperty Count"`,
        { timeout: 5000 }
      );
      startupCount = parseInt((regR.out || '0').trim()) || 0;
    } catch (_) {}

    // Primary disk usage
    const seen = new Set();
    const drives = (fsData || [])
      .filter(d => d && d.size > 500 * 1024 * 1024)
      .filter(d => { const k = d.fs || d.mount; if (seen.has(k)) return false; seen.add(k); return true; })
      .map(d => ({
        label: d.fs || d.mount,
        pct: d.size > 0 ? Math.round((d.used / d.size) * 100) : 0,
        totalGB: +(d.size / 1073741824).toFixed(1),
        freeGB: +((d.size - d.used) / 1073741824).toFixed(1),
      }));
    const mainDrive = drives[0] || { label: 'C:', pct: 0, totalGB: 0, freeGB: 0 };

    // ── Helper: extract app names from crash/hang messages ────────────────
    function extractAppNames(events) {
      const names = {};
      (events || []).forEach(ev => {
        const m = (ev.msg || '').match(/Faulting application name:\s*([^\s,]+)/i)
                || (ev.msg || '').match(/application:\s*([^\s,]+\.exe)/i)
                || (ev.msg || '').match(/([a-zA-Z0-9_\-]+\.exe)/i);
        if (m) {
          const n = m[1].toLowerCase();
          if (!['svchost.exe','system','ntoskrnl.exe'].includes(n))
            names[n] = (names[n] || 0) + 1;
        }
      });
      return Object.entries(names).sort((a,b) => b[1]-a[1]).slice(0, 5)
        .map(([n, c]) => `${n} (${c}x)`).join(', ');
    }

    // Extract stop codes from BSOD messages
    function extractStopCodes(events) {
      const codes = new Set();
      (events || []).forEach(ev => {
        const m = (ev.msg || '').match(/(0x[0-9A-Fa-f]{8,})/g);
        if (m) m.slice(0,2).forEach(c => codes.add(c));
      });
      return [...codes].slice(0,3).join(', ') || '';
    }

    // Normalize array — PowerShell sometimes returns object instead of array
    function toArr(v) {
      if (!v) return [];
      if (Array.isArray(v)) return v;
      if (typeof v === 'object' && v.ts) return [v];
      return [];
    }

    // All 35 categories
    const shutdowns    = toArr(raw.shutdowns);
    const cleanShut    = toArr(raw.cleanShut);
    const powerEvent   = toArr(raw.powerEvent);
    const bsod         = toArr(raw.bsod);
    const wer          = toArr(raw.wer);
    const appCrashes   = toArr(raw.appCrashes);
    const appHangs     = toArr(raw.appHangs);
    const diskErrors   = toArr(raw.diskErrors);
    const diskFull     = toArr(raw.diskFull);
    const ntfs         = toArr(raw.ntfs);
    const volmgr       = toArr(raw.volmgr);
    const storport     = toArr(raw.storport);
    const driverLoad   = toArr(raw.driverLoad);
    const driverCrash  = toArr(raw.driverCrash);
    const pnp          = toArr(raw.pnp);
    const acpi         = toArr(raw.acpi);
    const memErrors    = toArr(raw.memErrors);
    const thermal      = toArr(raw.thermal);
    const whea         = toArr(raw.whea);
    const cpuErr       = toArr(raw.cpuErr);
    const networkDrop  = toArr(raw.networkDrop);
    const dnsErr       = toArr(raw.dnsErr);
    const dhcp         = toArr(raw.dhcp);
    const netAdapter   = toArr(raw.netAdapter);
    const loginFail    = toArr(raw.loginFail);
    const loginSuccess = toArr(raw.loginSuccess);
    const policyChange = toArr(raw.policyChange);
    const firewall     = toArr(raw.firewall);
    const updateFail   = toArr(raw.updateFail);
    const sfc          = toArr(raw.sfc);
    const serviceCrash = toArr(raw.serviceCrash);
    const serviceHang  = toArr(raw.serviceHang);
    const dotnet       = toArr(raw.dotnet);
    const battery      = toArr(raw.battery);
    const oemHw        = toArr(raw.oemHw);
    const startupSlow  = toArr(raw.startupSlow);
    const bootErr      = toArr(raw.bootErr);

    const lastEvent = (arr) => arr.length ? arr[0].ts : null;

    // Collect unique event IDs seen — for AI report raw codes
    function uniqueIds(arr) { return [...new Set((arr||[]).map(e=>e.id).filter(Boolean))].join(','); }
    function topSources(arr, n=3) { 
      const m = {}; (arr||[]).forEach(e=>{ if(e.src) m[e.src]=(m[e.src]||0)+1; });
      return Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,n).map(([s,c])=>`${s}(${c}x)`).join(', ');
    }

    // ── Build findings ────────────────────────────────────────────────────
    const findings = [];

    // 1. Unexpected shutdowns
    if (shutdowns.length > 0) {
      const sev = shutdowns.length >= 5 ? 'critical' : 'warning';
      findings.push({ id:'shutdowns', severity:sev,
        title:'Unexpected Shutdowns / Auto-Restart',
        complaint:'PC suddenly turns off or restarts on its own',
        count:shutdowns.length, lastSeen:lastEvent(shutdowns),
        eventIds:uniqueIds(shutdowns), sources:topSources(shutdowns),
        detail:`PC shut down unexpectedly ${shutdowns.length} time(s). Event IDs: ${uniqueIds(shutdowns)||'41,6008'}.`,
        causes:['Overheating','Power supply issue','Driver crash','Windows bug'],
        solutions:[
          {label:'Check CPU Temp', action:'nav:health', icon:'🌡️'},
          {label:'View Processes', action:'nav:processes', icon:'📊'},
          {label:'Windows Update', action:'settings:ms-settings:windowsupdate', icon:'🔄'},
          {label:'Device Manager', action:'tool:devmgmt', icon:'🔧'},
        ],
        manualSteps:[
          'Clean laptop vents and fan with compressed air',
          'Check power cable and adapter connection',
          'Run Memory Diagnostic: Win+R → mdsched.exe',
          'Check Event Viewer: Win+R → eventvwr.msc → Windows Logs → System → filter Event ID 41',
        ],
      });
    }

    // 2. BSOD
    if (bsod.length > 0) {
      const codes = extractStopCodes(bsod);
      findings.push({ id:'bsod', severity:'critical',
        title:'Blue Screen of Death (BSOD)',
        complaint:'PC shows blue screen and restarts',
        count:bsod.length, lastSeen:lastEvent(bsod),
        eventIds:uniqueIds(bsod)||'1001',
        detail:`${bsod.length} BSOD crash(es) detected.${codes?' Stop codes: '+codes:''} Event ID 1001 (BugCheck).`,
        causes:['Faulty driver','RAM issue','Disk corruption','Overclocking'],
        solutions:[
          {label:'Update Drivers', action:'tool:devmgmt', icon:'🔧'},
          {label:'Windows Update', action:'settings:ms-settings:windowsupdate', icon:'🔄'},
          {label:'Run Disk Check', action:'cmd:chkdsk', icon:'💾'},
        ],
        manualSteps:[
          'Note the stop code from blue screen (e.g. DRIVER_IRQL_NOT_LESS_OR_EQUAL)',
          'Win+R → mdsched.exe → restart to test RAM',
          'Device Manager → Display Adapters → Update GPU driver',
          'Search stop code on Google or paste this report into AI for exact fix',
        ],
      });
    }

    // 3. WER / Error Reporting buckets
    if (wer.length > 0 && wer.length > appCrashes.length) {
      findings.push({ id:'wer', severity:'info',
        title:'Windows Error Reports (WER)',
        complaint:'Windows is silently logging errors in background',
        count:wer.length, lastSeen:lastEvent(wer),
        eventIds:uniqueIds(wer)||'1001,1026',
        detail:`${wer.length} Windows Error Reporting event(s). These are errors Windows has silently recorded. Sources: ${topSources(wer)||'WER'}.`,
        causes:['App or system faults reported to Microsoft','May be harmless background events'],
        solutions:[{label:'View Health Score', action:'nav:health', icon:'🩺'}],
        manualSteps:[
          'Open Windows Error Reporting: Control Panel → Security and Maintenance → View reliability history',
          'Reliability Monitor shows timeline of all errors — useful for diagnosis',
        ],
      });
    }

    // 4. App crashes
    if (appCrashes.length > 0) {
      const appNames = extractAppNames(appCrashes);
      const sev = appCrashes.length >= 10 ? 'critical' : appCrashes.length >= 3 ? 'warning' : 'info';
      findings.push({ id:'appcrash', severity:sev,
        title:'Application Crashes (Event ID 1000)',
        complaint:'Apps suddenly close without warning',
        count:appCrashes.length, lastSeen:lastEvent(appCrashes),
        eventIds:'1000',
        detail:`${appCrashes.length} crash(es). Apps affected: ${appNames||'various'}. Event ID 1000 (Application Error).`,
        causes:['Outdated app','Missing Windows update','Low memory','Corrupted install'],
        solutions:[
          {label:'Free RAM — Cleaner', action:'nav:cleaner', icon:'🧹'},
          {label:'Windows Update', action:'settings:ms-settings:windowsupdate', icon:'🔄'},
          {label:'View Processes', action:'nav:processes', icon:'📊'},
        ],
        manualSteps:[
          appNames ? `Update these apps first: ${appNames}` : 'Update all recently crashing apps',
          'Reinstall the app if updating does not fix it',
          'Settings → Apps → select app → Advanced options → Repair',
        ],
      });
    }

    // 5. App hangs
    if (appHangs.length > 0) {
      const hangNames = extractAppNames(appHangs);
      findings.push({ id:'apphang', severity:appHangs.length>=5?'warning':'info',
        title:'App Freezes / Not Responding (Event ID 1002)',
        complaint:'Apps freeze and show Not Responding',
        count:appHangs.length, lastSeen:lastEvent(appHangs),
        eventIds:'1002',
        detail:`${appHangs.length} freeze event(s). Apps: ${hangNames||'various'}. RAM currently ${ramPct}% used.`,
        causes:['High RAM usage','CPU overloaded','Disk 100%','App bug'],
        solutions:[
          {label:'Run Cleaner', action:'nav:cleaner', icon:'🧹'},
          {label:'Health Score', action:'nav:health', icon:'🩺'},
          {label:'Startup Apps', action:'settings:ms-settings:startupapps', icon:'🚀'},
        ],
        manualSteps:[
          'Ctrl+Shift+Esc → Task Manager → End Task on frozen apps',
          `You have ${startupCount} startup apps — disable unused ones`,
          'SSD upgrade gives biggest improvement if running on HDD',
        ],
      });
    }

    // 6. Disk errors
    const allDiskIssues = [...diskErrors, ...ntfs, ...volmgr, ...storport];
    if (allDiskIssues.length > 0) {
      findings.push({ id:'diskerror', severity:allDiskIssues.length>=5?'critical':'warning',
        title:'Disk / Storage Errors',
        complaint:'Slow PC, files corrupted, disk noise',
        count:allDiskIssues.length, lastSeen:lastEvent(allDiskIssues),
        eventIds:uniqueIds(allDiskIssues)||'7,11,15,55,129,153',
        detail:`${allDiskIssues.length} storage error event(s). Event IDs: ${uniqueIds(allDiskIssues)}. Sources: ${topSources(allDiskIssues)||'disk/NTFS/volmgr'}.`,
        causes:['Aging hard drive','Bad sectors','Loose SATA cable','Sudden power loss','NTFS corruption'],
        solutions:[
          {label:'Run Disk Check', action:'cmd:chkdsk', icon:'💾'},
          {label:'Hardware Info', action:'nav:hardware', icon:'🖥️'},
          {label:'Storage Sense', action:'settings:ms-settings:storagesense', icon:'📦'},
        ],
        manualSteps:[
          '⚠️ BACK UP YOUR FILES NOW if you see this warning',
          'Run: Command Prompt → chkdsk C: /scan (takes 5–20 min)',
          'Check SMART data in Hardware section of this app',
          'Consider replacing HDD with SSD if errors are frequent',
        ],
      });
    }

    // 7. Driver errors
    const allDriverIssues = [...driverLoad, ...driverCrash, ...pnp, ...acpi];
    if (allDriverIssues.length > 0) {
      findings.push({ id:'drivererror', severity:allDriverIssues.length>=3?'warning':'info',
        title:'Driver / Hardware Errors',
        complaint:'Device not working, display issues, hardware problems',
        count:allDriverIssues.length, lastSeen:lastEvent(allDriverIssues),
        eventIds:uniqueIds(allDriverIssues)||'219,7026,4101',
        detail:`${allDriverIssues.length} driver/hardware event(s). Event IDs: ${uniqueIds(allDriverIssues)}. Sources: ${topSources(allDriverIssues)}.`,
        causes:['Outdated driver','Driver conflict','Windows update broke driver','Hardware failure'],
        solutions:[
          {label:'Device Manager', action:'tool:devmgmt', icon:'🔧'},
          {label:'Windows Update', action:'settings:ms-settings:windowsupdate', icon:'🔄'},
        ],
        manualSteps:[
          'Open Device Manager → look for yellow warning triangles',
          'Right-click problem device → Update Driver → Search automatically',
          'If recently updated: Properties → Driver tab → Roll Back Driver',
          'Visit PC manufacturer website for latest drivers (Dell/HP/Lenovo support page)',
        ],
      });
    }

    // 8. WHEA / Hardware errors
    if (whea.length > 0 || cpuErr.length > 0) {
      const total = whea.length + cpuErr.length;
      findings.push({ id:'whea', severity:'critical',
        title:'Hardware / CPU Errors (WHEA)',
        complaint:'Random crashes, system instability, hardware failure warning',
        count:total, lastSeen:lastEvent([...whea,...cpuErr]),
        eventIds:uniqueIds([...whea,...cpuErr])||'1,17,18,19',
        detail:`${total} WHEA hardware error event(s). These indicate physical hardware problems. Event IDs: ${uniqueIds([...whea,...cpuErr])}.`,
        causes:['Failing CPU/RAM','Overheating hardware','Unstable overclock','Motherboard fault'],
        solutions:[
          {label:'Memory Diagnostic', action:'cmd:memdiag', icon:'🧠'},
          {label:'Check CPU Temp', action:'nav:health', icon:'🌡️'},
        ],
        manualSteps:[
          'Run: Win+R → mdsched.exe → test RAM immediately',
          'Check CPU temperature — should be under 80°C at load',
          'If overclocked: revert to stock settings',
          'Professional hardware check recommended if errors continue',
        ],
      });
    }

    // 9. Thermal throttling
    if (thermal.length > 0 || (cpuTemp && cpuTemp.main > 85)) {
      const tempStr = cpuTemp?.main ? `${cpuTemp.main}°C` : 'high';
      findings.push({ id:'thermal', severity:(thermal.length>=5||(cpuTemp?.main>95))?'critical':'warning',
        title:'Overheating / Thermal Throttling (Event ID 37)',
        complaint:'PC runs slow under load, fan is very loud',
        count:thermal.length, lastSeen:lastEvent(thermal),
        eventIds:uniqueIds(thermal)||'37',
        detail:`${thermal.length} thermal throttle event(s). CPU temp: ${tempStr}. PC auto-slows to prevent damage.`,
        causes:['Blocked vents','Dried thermal paste','Heavy background processes','Hot room'],
        solutions:[
          {label:'Live CPU Temp', action:'nav:health', icon:'🌡️'},
          {label:'Heavy Processes', action:'nav:processes', icon:'📊'},
          {label:'Power Settings', action:'settings:ms-settings:power-sleep', icon:'⚡'},
        ],
        manualSteps:[
          'Clean laptop vents with compressed air — most effective fix',
          'Use laptop on hard flat surface, not bed/pillow',
          'Close Chrome tabs and background apps during heavy work',
          'Change Power Plan to Balanced (not High Performance)',
          'Persistent overheating → professional thermal paste replacement',
        ],
      });
    }

    // 10. Network
    const allNetIssues = [...networkDrop, ...dnsErr, ...dhcp, ...netAdapter];
    if (allNetIssues.length > 0) {
      findings.push({ id:'network', severity:allNetIssues.length>=10?'warning':'info',
        title:'Network / Internet Issues',
        complaint:'Internet drops, WiFi disconnects, DNS slow',
        count:allNetIssues.length, lastSeen:lastEvent(allNetIssues),
        eventIds:uniqueIds(allNetIssues)||'4202,1014,27',
        detail:`${allNetIssues.length} network event(s). Event IDs: ${uniqueIds(allNetIssues)}. Types: disconnects, DNS failures, adapter resets.`,
        causes:['Weak WiFi signal','Router issue','Network driver problem','DNS failure','IP conflict'],
        solutions:[
          {label:'Flush DNS', action:'cmd:flush-dns', icon:'🌐'},
          {label:'Network Info', action:'nav:network', icon:'📶'},
          {label:'Network Settings', action:'settings:ms-settings:network-status', icon:'⚙️'},
        ],
        manualSteps:[
          'Flush DNS: this app → Network → Flush DNS button',
          'Move closer to router or switch to 5GHz WiFi band',
          'Restart router: unplug 30 seconds → plug back in',
          'Device Manager → Network Adapters → Update driver',
          'Win+R → ncpa.cpl → right-click adapter → Disable → Enable',
        ],
      });
    }

    // 11. Security — failed logins
    if (loginFail.length > 5) {
      findings.push({ id:'security', severity:loginFail.length>=20?'critical':'warning',
        title:'Multiple Failed Login Attempts (Event ID 4625)',
        complaint:'Possible unauthorized access attempts',
        count:loginFail.length, lastSeen:lastEvent(loginFail),
        eventIds:'4625',
        detail:`${loginFail.length} failed login attempt(s) in 30 days. ${loginFail.length>=20?'HIGH number — possible brute-force attack.':'May be normal (forgotten password / auto-login services).'}`,
        causes:['Wrong password attempts','Remote access attempts','Malware trying to access system accounts','Shared PC misuse'],
        solutions:[
          {label:'Account Settings', action:'settings:ms-settings:accounts', icon:'👤'},
          {label:'Windows Update', action:'settings:ms-settings:windowsupdate', icon:'🔄'},
        ],
        manualSteps:[
          'Check if you or family members caused these login failures',
          'Enable Windows Hello (fingerprint/PIN) instead of password',
          'Settings → Accounts → Sign-in options → set up Windows Hello',
          'If suspicious: change your Microsoft account password immediately',
          'Settings → Windows Security → Firewall & network protection → check rules',
        ],
      });
    }

    // 12. Firewall changes
    if (firewall.length > 0) {
      findings.push({ id:'firewall', severity:'info',
        title:'Firewall Rule Changes (Event ID 2003/2004)',
        complaint:'An app changed Windows Firewall settings',
        count:firewall.length, lastSeen:lastEvent(firewall),
        eventIds:uniqueIds(firewall)||'2003,2004',
        detail:`${firewall.length} firewall rule change(s) detected. An app or installer modified your firewall settings.`,
        causes:['App installation added firewall rule','Malware bypassing firewall','VPN software changes'],
        solutions:[
          {label:'Firewall Settings', action:'settings:ms-settings:windowsdefender', icon:'🛡️'},
        ],
        manualSteps:[
          'Win+R → wf.msc → check Inbound/Outbound Rules for unknown entries',
          'Settings → Windows Security → Firewall → Allow an app through firewall',
          'Remove rules for apps you do not recognize',
        ],
      });
    }

    // 13. Windows Update failures
    if (updateFail.length > 0) {
      findings.push({ id:'updatefail', severity:'warning',
        title:'Windows Update Failures (Event ID 20)',
        complaint:'Windows Update stuck or fails to install',
        count:updateFail.length, lastSeen:lastEvent(updateFail),
        eventIds:uniqueIds(updateFail)||'20',
        detail:`${updateFail.length} update failure(s). Missing updates = security risk and unpatched bugs.`,
        causes:['Low disk space','Corrupted update cache','Network interrupted'],
        solutions:[
          {label:'Windows Update', action:'settings:ms-settings:windowsupdate', icon:'🔄'},
          {label:'Free Disk Space', action:'nav:cleaner', icon:'🧹'},
        ],
        manualSteps:[
          'Free up at least 10GB disk space before updating',
          'Settings → Windows Update → Check for updates',
          'Run Update Troubleshooter: Settings → Troubleshoot → Windows Update',
          'Advanced: Win+R → services.msc → stop Windows Update → delete C:\Windows\SoftwareDistribution\Download → restart service',
        ],
      });
    }

    // 14. Service crashes
    const allServiceIssues = [...serviceCrash, ...serviceHang];
    if (allServiceIssues.length > 0) {
      findings.push({ id:'service', severity:allServiceIssues.length>=5?'warning':'info',
        title:'Windows Service Crashes / Failures',
        complaint:'Background features stop working, system unstable',
        count:allServiceIssues.length, lastSeen:lastEvent(allServiceIssues),
        eventIds:uniqueIds(allServiceIssues)||'7031,7034,7022',
        detail:`${allServiceIssues.length} service failure event(s). Sources: ${topSources(allServiceIssues)||'Service Control Manager'}.`,
        causes:['Corrupted system files','Third-party software conflict','Low resources'],
        solutions:[
          {label:'Windows Update', action:'settings:ms-settings:windowsupdate', icon:'🔄'},
          {label:'Startup Apps', action:'settings:ms-settings:startupapps', icon:'🚀'},
        ],
        manualSteps:[
          'Run SFC: search "Command Prompt" → Run as administrator → sfc /scannow',
          'Check for conflicting startup software',
          'Win+R → services.msc → find failed service → right-click → Properties → Recovery → set to Restart',
        ],
      });
    }

    // 15. Slow boot
    const allBootIssues = [...bootErr, ...startupSlow];
    if (allBootIssues.length > 0 || startupCount > 10) {
      findings.push({ id:'slowboot', severity:startupCount>15?'warning':'info',
        title:'Slow Boot / Startup Performance',
        complaint:'PC takes long to start, slow after login',
        count:Math.max(allBootIssues.length, startupCount),
        lastSeen:lastEvent(allBootIssues),
        eventIds:uniqueIds(allBootIssues)||'100,101',
        detail:`${startupCount} apps launch at startup. ${allBootIssues.length>0?allBootIssues.length+' slow boot event(s) detected.':''}`,
        causes:['Too many startup apps','HDD (not SSD)','Pending updates'],
        solutions:[
          {label:'Manage Startup Apps', action:'settings:ms-settings:startupapps', icon:'🚀'},
          {label:'View Startup Section', action:'nav:startup', icon:'🖥️'},
        ],
        manualSteps:[
          'Open Startup Apps section in this app → disable apps you do not need at boot',
          'Keep: Antivirus, audio driver. Disable: Teams, Spotify, Discord, Zoom, OneDrive if not needed',
          'Task Manager → Startup tab → right-click → Disable',
        ],
      });
    }

    // 16. .NET / VC++ Runtime crashes
    if (dotnet.length > 0) {
      findings.push({ id:'dotnet', severity:'info',
        title:'.NET / Visual C++ Runtime Errors (Event ID 1026)',
        complaint:'Specific apps crash with runtime errors',
        count:dotnet.length, lastSeen:lastEvent(dotnet),
        eventIds:'1026',
        detail:`${dotnet.length} .NET runtime crash(es). Apps built on .NET/VC++ framework are failing.`,
        causes:['Outdated .NET runtime','Corrupted runtime install','App targeting wrong .NET version'],
        solutions:[
          {label:'Windows Update', action:'settings:ms-settings:windowsupdate', icon:'🔄'},
        ],
        manualSteps:[
          'Windows Update often includes .NET runtime updates — run it first',
          'Download latest .NET runtime from microsoft.com/net',
          'Download latest Visual C++ Redistributables from Microsoft',
          'Reinstall the app that is crashing',
        ],
      });
    }

    // 17. Disk full
    if (diskFull.length > 0 || mainDrive.pct > 85) {
      findings.push({ id:'diskfull', severity:(diskFull.length>0||mainDrive.pct>90)?'critical':'warning',
        title:'Low Disk Space',
        complaint:'Storage almost full, PC slowing down',
        count:diskFull.length, lastSeen:lastEvent(diskFull),
        eventIds:uniqueIds(diskFull)||'2013',
        detail:`Drive ${mainDrive.label}: ${mainDrive.pct}% used, only ${mainDrive.freeGB} GB free.${diskFull.length?' Event ID 2013 (volume out of space) detected.':''}`,
        causes:['Temp files','Browser cache','Downloads','Windows Update leftovers'],
        solutions:[
          {label:'Run Cleaner', action:'nav:cleaner', icon:'🧹'},
          {label:'Storage Sense', action:'settings:ms-settings:storagesense', icon:'📦'},
        ],
        manualSteps:[
          'Use Cleaner section of this app to remove temp and cache files',
          'Delete files from Downloads folder',
          'Move photos/videos to external drive or cloud',
          'Settings → System → Storage → Cleanup recommendations',
        ],
      });
    }

    // 18. OEM hardware warnings
    if (oemHw.length > 0) {
      findings.push({ id:'oemhw', severity:'info',
        title:'OEM / Firmware Hardware Events',
        complaint:'Hardware-specific warnings from PC manufacturer',
        count:oemHw.length, lastSeen:lastEvent(oemHw),
        eventIds:uniqueIds(oemHw),
        detail:`${oemHw.length} OEM hardware event(s) from: ${topSources(oemHw)||'firmware/BIOS/sensors'}.`,
        causes:['BIOS/firmware issue','Sensor warning','Fan/thermal sensor alert'],
        solutions:[{label:'Device Manager', action:'tool:devmgmt', icon:'🔧'}],
        manualSteps:[
          'Check PC manufacturer website for BIOS/firmware updates',
          'Dell: Dell Command Update | HP: HP Support Assistant | Lenovo: Lenovo System Update',
          'Run manufacturer diagnostics: Dell SupportAssist / HP PC Hardware Diagnostics',
        ],
      });
    }

    // 19. Battery issues (laptops)
    if (battery.length > 0) {
      findings.push({ id:'battery', severity:'info',
        title:'Battery / Power State Events',
        complaint:'Battery draining fast, not charging properly',
        count:battery.length, lastSeen:lastEvent(battery),
        eventIds:uniqueIds(battery)||'26,27',
        detail:`${battery.length} battery/power event(s) detected in system log.`,
        causes:['Aging battery','Power adapter issue','Battery driver issue'],
        solutions:[
          {label:'Power Settings', action:'settings:ms-settings:power-sleep', icon:'⚡'},
          {label:'Battery Report', action:'nav:report', icon:'🔋'},
        ],
        manualSteps:[
          'Run battery report: Win+R → cmd → powercfg /batteryreport → open report in Downloads',
          'Settings → System → Power & sleep → Battery saver settings',
          'Check battery health in Report section of this app',
        ],
      });
    }

    // 20. Live RAM check
    if (ramPct > 85 && !findings.find(f=>f.id==='apphang')) {
      findings.push({ id:'highram', severity:ramPct>92?'critical':'warning',
        title:'High RAM Usage (Live Reading)',
        complaint:'PC slow, apps take long to open',
        count:0, lastSeen:null, eventIds:'',
        detail:`RAM is currently ${ramPct}% used (${((totalRam-freeRam)/1073741824).toFixed(1)} GB of ${(totalRam/1073741824).toFixed(1)} GB).`,
        causes:['Too many apps open','Memory leak','Insufficient RAM'],
        solutions:[
          {label:'View Processes', action:'nav:processes', icon:'📊'},
          {label:'Startup Apps', action:'settings:ms-settings:startupapps', icon:'🚀'},
        ],
        manualSteps:[
          'Task Manager → Memory column → close top memory-consuming apps',
          `Disable startup apps — you have ${startupCount} items starting with Windows`,
          'Restart PC to clear memory leaks',
        ],
      });
    }

            // ── Build AI-ready prompt ─────────────────────────────────────────────
    const ts = new Date().toLocaleString('en-IN');
    const sysLine = [
      sysInfo ? `${sysInfo.manufacturer||''} ${sysInfo.model||''}`.trim() : 'Unknown PC',
      sysInfo?.os || 'Windows',
      sysInfo?.cpu?.brand || os.cpus()[0]?.model || 'Unknown CPU',
      `${(os.totalmem()/1073741824).toFixed(1)} GB RAM`,
    ].filter(Boolean).join(' | ');

    const severityLabel = { critical:'🔴 CRITICAL', warning:'🟡 WARNING', info:'🔵 INFO' };

    let aiPrompt = '';
    aiPrompt += `I am having PC problems. Below is my full diagnostic report generated by PC Smart Utility.\n`;
    aiPrompt += `Please analyze ALL issues and give me specific step-by-step solutions for each one.\n`;
    aiPrompt += `I am a regular user with no technical background.\n\n`;
    aiPrompt += `════════════════════════════════════════════\n`;
    aiPrompt += `  PC SMART UTILITY — FULL DIAGNOSTIC REPORT\n`;
    aiPrompt += `════════════════════════════════════════════\n\n`;
    aiPrompt += `SYSTEM INFORMATION\n──────────────────\n`;
    aiPrompt += `PC      : ${sysLine}\n`;
    aiPrompt += `Scanned : ${ts}\nPeriod  : Last 30 days of Windows Event Logs\n\n`;
    aiPrompt += `CURRENT LIVE SYSTEM STATE\n─────────────────────────\n`;
    aiPrompt += `CPU Usage       : ${cpuLoad.currentLoad.toFixed(1)}%\n`;
    aiPrompt += `RAM Usage       : ${ramPct}% (${((totalRam-freeRam)/1073741824).toFixed(1)} GB used of ${(totalRam/1073741824).toFixed(1)} GB)\n`;
    aiPrompt += `Disk ${mainDrive.label}        : ${mainDrive.pct}% full (${mainDrive.freeGB} GB free of ${mainDrive.totalGB} GB)\n`;
    if (cpuTemp?.main) aiPrompt += `CPU Temperature : ${cpuTemp.main}°C${cpuTemp.main>90?' ⚠️ HIGH':cpuTemp.main>75?' ⚠️ WARM':''}\n`;
    aiPrompt += `Startup Apps    : ${startupCount} apps launch at boot\n`;
    aiPrompt += `System Uptime   : ${Math.floor(os.uptime()/3600)} hours\n\n`;

    if (findings.length === 0) {
      aiPrompt += `DIAGNOSTIC RESULT\n─────────────────\n`;
      aiPrompt += `✅ No problems detected in last 30 days. System appears healthy.\n`;
    } else {
      aiPrompt += `PROBLEMS DETECTED (${findings.length} issues found)\n`;
      aiPrompt += `────────────────────────────────────────\n`;
      const sortedF = [...findings].sort((a,b)=>{const o={critical:0,warning:1,info:2};return(o[a.severity]||3)-(o[b.severity]||3);});
      sortedF.forEach((f, i) => {
        const lbl = severityLabel[f.severity] || f.severity.toUpperCase();
        aiPrompt += `\n${i+1}. ${lbl} — ${f.title}\n`;
        if (f.count > 0)  aiPrompt += `   Occurrences : ${f.count} time(s) in last 30 days\n`;
        if (f.lastSeen)   aiPrompt += `   Last Seen   : ${f.lastSeen}\n`;
        if (f.eventIds)   aiPrompt += `   Event IDs   : ${f.eventIds}\n`;
        if (f.sources)    aiPrompt += `   Sources     : ${f.sources}\n`;
        aiPrompt += `   Detail      : ${f.detail}\n`;
        aiPrompt += `   Likely causes: ${f.causes.join(', ')}\n`;
        aiPrompt += `   User complaint: "${f.complaint}"\n`;
      });
    }

    aiPrompt += `\n════════════════════════════════════════════\n`;
    aiPrompt += `WHAT I NEED FROM YOU\n────────────────────\n`;
    aiPrompt += `For EACH problem listed above, please provide:\n`;
    aiPrompt += `1. Simple explanation of what this means in plain language\n`;
    aiPrompt += `2. Step-by-step fix (assume I am a complete beginner)\n`;
    aiPrompt += `3. Whether I need a technician or can fix it myself\n`;
    aiPrompt += `4. How to prevent this problem in future\n`;
    aiPrompt += `\nThank you.\n`;
    aiPrompt += `\n════════════════════════════════════════════\n`;
    aiPrompt += `BONUS REQUEST\n`;
    aiPrompt += `────────────\n`;
    aiPrompt += `Also give me ONE combined Windows Command Prompt command (run as Administrator)\n`;
    aiPrompt += `that auto-fixes as many of the above issues as possible in one shot.\n`;
    aiPrompt += `Format: single copy-paste line. Label it clearly as --- ADMIN CMD FIX ---.\n`;
    // ── Summary counts ────────────────────────────────────────────────────
    const criticalCount = findings.filter(f => f.severity === 'critical').length;
    const warningCount  = findings.filter(f => f.severity === 'warning').length;

    return {
      ok: true,
      scannedAt: ts,
      findings,
      criticalCount,
      warningCount,
      aiPrompt,
      systemState: {
        cpuPct: cpuLoad.currentLoad,
        ramPct,
        diskPct: mainDrive.pct,
        diskLabel: mainDrive.label,
        diskFreeGB: mainDrive.freeGB,
        cpuTemp: cpuTemp?.main || null,
        startupCount,
        uptimeHours: Math.floor(uptimeSec / 3600),
      },
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Diagnostic action handler ──────────────────────────────────────────────
safeHandle('diag-action', async (_, action) => {
  try {
    if (action === 'cmd:chkdsk') {
      const r = await safeExec('chkdsk C: /scan', { timeout: 30000 });
      return { ok: true, output: r.out || r.err || 'Disk check complete.' };
    }
    if (action === 'cmd:memdiag') {
      spawn('mdsched.exe', [], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true, output: 'Memory Diagnostic opened. Choose "Restart now" to begin testing.' };
    }
    if (action === 'tool:devmgmt') { openTool('devmgmt'); return { ok: true }; }
    if (action === 'cmd:flush-dns') {
      const r = await safeExec('ipconfig /flushdns', { timeout: 8000 });
      return { ok: r.ok, output: r.ok ? 'DNS cache flushed successfully.' : r.err };
    }
    if (action.startsWith('settings:')) {
      const uri = action.slice('settings:'.length);
      // Never accept arbitrary ms-settings URIs from renderer input.
      if (ALLOWED_MS_SETTINGS.has(uri)) {
        shell.openExternal(uri).catch(() => {});
        return { ok: true };
      }
      return { ok: false, output: 'Settings URI is not allowlisted.' };
    }
    return { ok: false, output: 'Unknown action.' };
  } catch (e) { return { ok: false, output: e.message }; }
});
