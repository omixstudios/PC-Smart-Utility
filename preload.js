'use strict';
// PC Smart Utility v5.8.7 — preload.js
// sandbox:true compatible — contextBridge only, no require() in renderer

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // System
  getInstantInfo:      ()         => ipcRenderer.invoke('get-instant-info'),
  notifDiagnostics:    ()         => ipcRenderer.invoke('notif-diagnostics'),
  getSystemInfo:       (force)    => ipcRenderer.invoke('get-system-info', force),
  getRealtime:         ()         => ipcRenderer.invoke('get-realtime'),
  getBattery:          ()         => ipcRenderer.invoke('get-battery'),
  getDiskLayout:       (force)    => ipcRenderer.invoke('get-disk-layout', force),
  getGraphics:         (force)    => ipcRenderer.invoke('get-graphics', force),
  getCpuTemperature:   ()         => ipcRenderer.invoke('get-cpu-temperature'),
  getNetIfaces:        ()         => ipcRenderer.invoke('get-net-ifaces'),
  getProcesses:        ()         => ipcRenderer.invoke('get-processes'),
  getHealthScore:      ()         => ipcRenderer.invoke('get-health-score'),

  // Network
  getNetworkInfo:      ()         => ipcRenderer.invoke('get-network-info'),
  pingHost:            (host)     => ipcRenderer.invoke('ping-host', host),
  flushDns:            ()         => ipcRenderer.invoke('flush-dns'),
  checkInternet:       ()         => ipcRenderer.invoke('check-internet'),
  getWifiStrength:     ()         => ipcRenderer.invoke('get-wifi-strength'),
  nslookup:            (domain)   => ipcRenderer.invoke('nslookup', domain),
  tracert:             (host)     => ipcRenderer.invoke('tracert', host),
  portCheck:           (host, p)  => ipcRenderer.invoke('port-check', host, p),
  getPublicIp:         ()         => ipcRenderer.invoke('get-public-ip'),

  // Commands
  runCmd:              (key)      => ipcRenderer.invoke('run-cmd', key),
  runCmdInput:         (t, i)     => ipcRenderer.invoke('run-cmd-input', t, i),

  // System info extras
  getEnvVars:          ()         => ipcRenderer.invoke('get-env-vars'),
  getHostsFile:        ()         => ipcRenderer.invoke('get-hosts-file'),
  getInstalledSoftware:()         => ipcRenderer.invoke('get-installed-software'),
  getStartupApps:      ()         => ipcRenderer.invoke('get-startup-apps'),

  // Cleaner
  estimateSizes:       ()         => ipcRenderer.invoke('estimate-sizes'),
  cleanTemp:           ()         => ipcRenderer.invoke('clean-temp'),
  cleanThumbcache:     ()         => ipcRenderer.invoke('clean-thumbcache'),
  cleanRecent:         ()         => ipcRenderer.invoke('clean-recent'),
  cleanRecycle:        ()         => ipcRenderer.invoke('clean-recycle'),
  cleanBrowserCache:   (browsers) => ipcRenderer.invoke('clean-browser-cache', browsers),

  // Scheduler
  getSchedule:         ()         => ipcRenderer.invoke('get-schedule'),
  saveSchedule:        (s)        => ipcRenderer.invoke('save-schedule', s),
  runAutoClean:        ()         => ipcRenderer.invoke('run-auto-clean'),

  // Clipboard (generic copy helper — used across many features, not the removed Clipboard History section)
  copyToClipboard:     (text)     => ipcRenderer.invoke('copy-to-clipboard', text),
  clearClipboardNow:   ()         => ipcRenderer.invoke('clear-clipboard-now'),

  // Export
  getDiagnosticReport: ()         => ipcRenderer.invoke('get-diagnostic-report'),
  diagAction:          (action)   => ipcRenderer.invoke('diag-action', action),
  exportReport:        ()         => ipcRenderer.invoke('export-report'),
  exportReportExcel:   ()         => ipcRenderer.invoke('export-report-excel'),
  exportReportPDF:     ()         => ipcRenderer.invoke('export-report-pdf'),
  exportReportWord:    ()         => ipcRenderer.invoke('export-report-word'),
  generateQRSvg:         ()       => ipcRenderer.invoke('generate-qr-svg'),
  generateBarcodeSvg:    ()       => ipcRenderer.invoke('generate-barcode-svg'),
  exportQRImage:         (svg)    => ipcRenderer.invoke('export-qr-image', svg),
  exportBarcodeImage:    (svg)    => ipcRenderer.invoke('export-barcode-image', svg),
  checkStoreVersion:     ()       => ipcRenderer.invoke('check-store-version'),
  exportOutputTxt:     (opts)     => ipcRenderer.invoke('export-output-txt', opts),
  copyReportClipboard: ()         => ipcRenderer.invoke('copy-report-clipboard'),
  runDiskDefrag:       ()         => ipcRenderer.invoke('run-disk-defrag'),
  runBatteryReport:    ()         => ipcRenderer.invoke('run-battery-report'),
  openBatteryReportHtml: ()       => ipcRenderer.invoke('open-battery-report-html'),
  openUninstallSettings:()        => ipcRenderer.invoke('open-uninstall-settings'),
  openStartupSettings: ()         => ipcRenderer.invoke('open-startup-settings'),

  // One-way sends
  openTool:            (key)      => ipcRenderer.send('open-tool', key),
  openSettings:        (uri)      => ipcRenderer.send('open-settings', uri),
  openRunDialog:       ()         => ipcRenderer.send('open-run-dialog'),
  openTaskManager:     ()         => ipcRenderer.send('open-task-manager'),
  openCalculator:      ()         => ipcRenderer.send('open-calculator'),
  openNotepad:         ()         => ipcRenderer.send('open-notepad'),
  openUrl:             (url)      => ipcRenderer.send('open-url', url),
  lockScreen:          ()         => ipcRenderer.send('lock-screen'),
  restartExplorer:     ()         => ipcRenderer.send('restart-explorer'),
  sleep:               ()         => ipcRenderer.send('sleep'),
  hibernate:           ()         => ipcRenderer.send('hibernate'),
  shareApp:            ()         => ipcRenderer.send('share-app'),
  openStore:           ()         => ipcRenderer.send('open-store'),
  openStoreReview:     ()         => ipcRenderer.send('open-store-review'),

  // Quick Links
  loadQuickLinks:      ()         => ipcRenderer.invoke('load-quick-links').then(r => r.data),
  saveQuickLinks:      (data)     => ipcRenderer.invoke('save-quick-links', data),
  exportQuickLinks:    (json)     => ipcRenderer.invoke('export-quick-links', json),
  importQuickLinks:    ()         => ipcRenderer.invoke('import-quick-links').then(r => r.json),
  openExternalUrl:     (url)      => ipcRenderer.send('open-external-url', url),

  // Preferences (theme, etc.) — persisted to userData/prefs.json, not localStorage
  getPref:             (key)      => ipcRenderer.invoke('get-pref',  key),
  savePref:            (key, val) => ipcRenderer.invoke('save-pref', key, val),

  // First-run & misc
  checkFirstRun:       ()         => ipcRenderer.invoke('check-first-run'),
  getAutostart:        ()         => ipcRenderer.invoke('get-autostart'),
  setAutostart:        (enable)   => ipcRenderer.invoke('set-autostart', enable),
  getOemInfo:          ()         => ipcRenderer.invoke('get-oem-info'),
  getErrorLog:         ()                    => ipcRenderer.invoke('get-error-log'),
  clearErrorLog:       ()                    => ipcRenderer.invoke('clear-error-log'),
  logEvent:            (ev, sec, det)        => ipcRenderer.invoke('log-event', ev, sec, det),
  getAnalytics:        ()                    => ipcRenderer.invoke('get-analytics'),
  clearAnalytics:      ()                    => ipcRenderer.invoke('clear-analytics'),
  getHealthScoreCached:()         => ipcRenderer.invoke('get-health-score-cached'),

  // Task Reminder

  // Listeners (one-direction from main → renderer)
  onAutoCleanPrompt:   (cb)       => { ipcRenderer.removeAllListeners('auto-clean-prompt');  ipcRenderer.on('auto-clean-prompt', () => cb()); },
  onUrlBlocked:        (cb)       => { ipcRenderer.removeAllListeners('url-blocked');        ipcRenderer.on('url-blocked', (_, url) => cb(url)); },
  onMonitoringPaused:  (cb)       => { ipcRenderer.removeAllListeners('monitoring-paused'); ipcRenderer.on('monitoring-paused', (_, paused) => cb(paused)); },
  onNavigateTo:        (cb)       => { ipcRenderer.removeAllListeners('navigate-to-section'); ipcRenderer.on('navigate-to-section', (_, sec) => cb(sec)); },
  onBatteryCareAlert:  (cb)       => { ipcRenderer.removeAllListeners('battery-care-alert'); ipcRenderer.on('battery-care-alert', (_, data) => cb(data)); },
  cyberQuizNotify:     (title, body) => ipcRenderer.invoke('cyber-quiz-notify', title, body),
  quizSettingsSave:    (settings)   => ipcRenderer.invoke('quiz-settings-save', settings),
  generateCustomQR:    (payload)  => ipcRenderer.invoke('generate-custom-qr', payload),
});
