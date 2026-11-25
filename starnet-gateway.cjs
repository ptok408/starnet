'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const { createHash, timingSafeEqual } = require('node:crypto');

const PUBLIC_HOST = 'starnet.ogarnijfirme.com';
const APP_PORT = Number(process.env.STARNET_PORT || 8787);
const GATEWAY_PORT = 8788;
const USER = process.env.STARNET_LOGIN_USER || '';
const PASS = process.env.STARNET_LOGIN_PASSWORD || '';

if (!USER || PASS.length < 11) {
  console.error('Set STARNET_LOGIN_USER and STARNET_LOGIN_PASSWORD (11+ chars).');
  process.exit(1);
}

function sameSecret(a, b) {
  const digest = s => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function authorize(req, res) {
  const host = String(req.headers.host || '').toLowerCase().replace(/:443$/, '');
  if (host !== PUBLIC_HOST) {
    res.writeHead(421).end();
    return false;
  }

  if (req.headers.origin && req.headers.origin !== 'https://' + PUBLIC_HOST) {
    res.writeHead(403).end();
    return false;
  }

  const header = String(req.headers.authorization || '');
  const provided = header.startsWith('Basic ') && header.length < 10000
    ? Buffer.from(header.slice(6), 'base64') : Buffer.alloc(0);

  if (!sameSecret(provided, Buffer.from(USER + ':' + PASS))) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="StarNet", charset="UTF-8"',
      'Cache-Control': 'no-store'
    }).end('Authentication required');
    return false;
  }

  return true;
}

const child = spawn(process.execPath, ['sidecar/index.js'], {
  cwd: __dirname,
  env: process.env,
  stdio: 'inherit'
});

child.on('exit', code => process.exit(code || 1));

const gateway = http.createServer((req, res) => {
  if (!authorize(req, res)) return;

  const headers = { ...req.headers, host: '127.0.0.1:' + APP_PORT };
  delete headers.authorization;
  delete headers['x-forwarded-for'];
  delete headers['x-forwarded-host'];
  delete headers['x-forwarded-proto'];
  delete headers.forwarded;

  if (headers.origin) {
    headers.origin = 'http://127.0.0.1:' + APP_PORT;
  }

  const upstream = http.request({
    hostname: '127.0.0.1',
    port: APP_PORT,
    path: req.url,
    method: req.method,
    headers
  }, reply => {
    const responseHeaders = { ...reply.headers };
    delete responseHeaders['access-control-allow-origin'];
    res.writeHead(reply.statusCode || 502, responseHeaders);
    reply.pipe(res);
  });

  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    res.end('StarNet is not responding yet');
  });

  req.pipe(upstream);
});

gateway.listen(GATEWAY_PORT, '0.0.0.0', () => {
  console.log('Protected StarNet gateway listening on port ' + GATEWAY_PORT);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    gateway.close();
    child.kill(signal);
  });
}
