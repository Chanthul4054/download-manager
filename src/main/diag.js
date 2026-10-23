'use strict';
// Opt-in structured diagnostics: set OPENDM_DIAG=1 to print one JSON line per event to stderr.
// Addresses are reduced to origin + path, so query strings (signed URLs, tokens), user info,
// cookies and headers never reach the log.

const enabled = () => !!process.env.OPENDM_DIAG;

function redactUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return '(invalid url)';
  }
}

function diag(event, fields = {}) {
  if (!enabled()) return;
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + '\n');
}

module.exports = { diag, redactUrl, enabled };
