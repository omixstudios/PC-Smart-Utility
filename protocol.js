'use strict';
// Custom protocol handler — replaces loadFile() so sandbox:true works
// Registers app:// as a secure local file protocol
// v7.0.2: protocol.handle() for Electron 29+; async file-exists check (no existsSync blocking)

const { protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_ROOT = __dirname;

// Cache of known-good file paths to skip redundant fs.promises.access calls
// (index.html, styles.css, preload.js hit on every navigation — cache after first check)
const _existsCache = new Map();

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    try {
      let urlPath = request.url.slice('app://'.length);
      urlPath = urlPath.split('?')[0];
      urlPath = decodeURIComponent(urlPath);
      // Strip leading slashes/dots
      urlPath = urlPath.replace(/^[./]+/, '');
      const filePath = path.normalize(path.join(APP_ROOT, urlPath));
      // Path traversal guard — must stay within app root
      if (!filePath.startsWith(APP_ROOT + path.sep) && filePath !== APP_ROOT) {
        return new Response(null, { status: 404 });
      }
      // Async existence check — never blocks event loop (critical on HDD)
      let exists = _existsCache.get(filePath);
      if (exists === undefined) {
        exists = await fs.promises.access(filePath).then(() => true).catch(() => false);
        if (exists) _existsCache.set(filePath, true); // only cache hits, not misses
      }
      if (!exists) return new Response(null, { status: 404 });
      return net.fetch('file://' + filePath);
    } catch (_) {
      return new Response(null, { status: 500 });
    }
  });
}

module.exports = { registerAppProtocol };

// ── pcsmartutility:// deep-link protocol ─────────────────────────────────────
// Registered so Windows Toast notifications (fired by Task Scheduler PowerShell)
// can launch / foreground the app and navigate to a specific page when clicked.
// Registration happens in main.js at app startup via registerDeepLinkProtocol().
// The protocol is used by MSIX/APPX builds only; non-APPX builds use --arg flags.
// ─────────────────────────────────────────────────────────────────────────────
function registerDeepLinkProtocol(app, getMainWindow, navigateFn) {
  // Register as default handler for pcsmartutility:// URIs
  if (!app.isDefaultProtocolClient('pcsmartutility')) {
    app.setAsDefaultProtocolClient('pcsmartutility');
  }

  // Windows: second-instance fires when toast clicked and app already running
  app.on('second-instance', (_event, argv) => {
    const url = argv.find(a => a.startsWith('pcsmartutility://'));
    if (url) _handleDeepLink(url, getMainWindow, navigateFn);
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  // Windows: first-instance open-url (app was closed, toast re-launched it)
  app.on('open-url', (_event, url) => {
    _handleDeepLink(url, getMainWindow, navigateFn);
  });
}

function _handleDeepLink(url, getMainWindow, navigateFn) {
  try {
    // pcsmartutility://cybersecurity → page = 'cybersecurity'
    const page = url.replace('pcsmartutility://', '').split('/')[0].split('?')[0];
    if (!page) return;
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      navigateFn(page);
    }
  } catch (_) {}
}

module.exports.registerDeepLinkProtocol = registerDeepLinkProtocol;
