'use strict';

// Request-level guard for the local HTTP API. The server evals arbitrary JS by design
// (/api/evaluate), so "who can reach it" is the entire security model. Binding 127.0.0.1
// keeps other machines out; this module handles the two ways a request can still arrive
// from an attacker via the user's own browser:
//
// - DNS rebinding: a malicious page's domain resolves to 127.0.0.1, so the browser happily
//   sends same-"origin" requests to us - but with the attacker's domain in the Host header.
//   Rejecting non-loopback Host headers closes this.
// - Drive-by cross-origin POSTs: CORS stops a foreign page from *reading* our responses, not
//   from *sending* requests - and /api/evaluate does its damage on send. Browsers attach the
//   page's Origin to every POST, so a loopback allowlist on Origin closes this. (Non-browser
//   clients like curl send no Origin header and pass; GETs are read-only and left to CORS.)
//
// Pure functions, no server state - see request-guard.test.js.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// "localhost:4000" -> "localhost", "[::1]:4000" -> "[::1]", "::1" -> "::1". IPv6 hosts are
// bracketed whenever a port follows, so an unbracketed value with 2+ colons is a bare IPv6
// address (e.g. POPTART_HOST=::1), not host:port - strip nothing from those.
function stripPort(host) {
  const s = String(host || '').toLowerCase();
  if (s.startsWith('[')) return s.replace(/\]:\d+$/, ']');
  const firstColon = s.indexOf(':');
  if (firstColon !== -1 && firstColon === s.lastIndexOf(':')) return s.slice(0, firstColon);
  return s;
}

function isLoopbackHostname(host) {
  return LOOPBACK_HOSTS.has(stripPort(host));
}

// Why this request must be refused, or null to let it through. `hostHeader`/`originHeader`
// are the raw header values (undefined when absent).
function blockReason({ method, hostHeader, originHeader }) {
  if (!isLoopbackHostname(hostHeader)) {
    return `refused: Host "${hostHeader ?? '(missing)'}" is not localhost (DNS-rebinding guard - see request-guard.js)`;
  }
  if (method === 'POST' && originHeader !== undefined) {
    let originHost = null;
    try {
      originHost = new URL(originHeader).host;
    } catch {
      // unparseable Origin (including the literal "null" a sandboxed/file:// page sends)
    }
    if (originHost === null || !isLoopbackHostname(originHost)) {
      return `refused: cross-origin POST from "${originHeader}" (drive-by guard - see request-guard.js)`;
    }
  }
  return null;
}

module.exports = { blockReason, isLoopbackHostname };
