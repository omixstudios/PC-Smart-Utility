'use strict';
// Minimal MIME type map for local app:// protocol
const MIME_MAP = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
};

function getMimeType(ext) {
  return MIME_MAP[ext.toLowerCase()] || 'application/octet-stream';
}

module.exports = { getMimeType };
