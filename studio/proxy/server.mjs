#!/usr/bin/env node
import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BODY_LIMIT = 16 * 1024 * 1024;
const JSON_LIMIT = 23 * 1024 * 1024;
const REDIRECT_LIMIT = 5;
const REQUEST_TIMEOUT = 15000;
const RATE_WINDOW = 60000;
const DEFAULT_RATE_LIMIT = 60;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const FORWARDED_HEADERS = new Set(['accept', 'accept-language', 'content-type', 'if-modified-since', 'if-none-match', 'range']);
const RESPONSE_HEADERS = new Set(['cache-control', 'content-disposition', 'content-language', 'content-type', 'etag', 'last-modified', 'location']);

function response(res, status, value, corsOrigin) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (corsOrigin) {
    headers['access-control-allow-origin'] = corsOrigin;
    headers['access-control-allow-methods'] = 'POST, OPTIONS';
    headers['access-control-allow-headers'] = 'content-type';
    headers.vary = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(value === null ? '' : JSON.stringify(value));
}

function publicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

function checkedUrl(raw, allowedHosts) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only HTTP and HTTPS URLs are allowed.');
  if (url.username || url.password || url.hash) throw new Error('URL credentials and fragments are not supported.');
  const host = url.hostname.toLowerCase();
  if (!host || isIP(host) || !allowedHosts.has(host)) throw new Error('This host is not in the proxy allowlist.');
  if ((url.protocol === 'http:' && url.port && url.port !== '80') ||
      (url.protocol === 'https:' && url.port && url.port !== '443'))
    throw new Error('Only the standard HTTP and HTTPS ports are allowed.');
  return url;
}

async function publicAddress(host) {
  const records = await lookup(host, { all: true, verbatim: true });
  const record = records.find(item => publicIPv4(item.address));
  if (!record) throw new Error('The allowed host did not resolve to a public IPv4 address.');
  return record.address;
}

function requestPinned(url, options, address) {
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = transport({
      protocol: url.protocol, hostname: url.hostname, port: url.port || undefined,
      path: url.pathname + url.search, method: options.method, headers: options.headers,
      lookup: (_host, _opts, callback) => callback(null, address, 4),
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > BODY_LIMIT) {
          req.destroy(new Error('Upstream response exceeds the 16 MiB limit.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({
        status: res.statusCode || 502,
        statusText: res.statusMessage || 'Response',
        headers: Object.fromEntries(Object.entries(res.headers)
          .filter(([name, value]) => RESPONSE_HEADERS.has(name) && typeof value === 'string')),
        body: Buffer.concat(chunks),
      }));
      res.on('error', reject);
    });
    req.setTimeout(REQUEST_TIMEOUT, () => req.destroy(new Error('Upstream request timed out.')));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function fetchAllowed(raw, options, allowedHosts, upstream) {
  let url = checkedUrl(raw, allowedHosts);
  for (let hop = 0; hop <= REDIRECT_LIMIT; hop++) {
    const address = await publicAddress(url.hostname);
    const result = await upstream(url, options, address);
    const location = result.headers.location;
    if (![301, 302, 303, 307, 308].includes(result.status) || !location) return result;
    if (hop === REDIRECT_LIMIT) throw new Error('Upstream exceeded the redirect limit.');
    url = checkedUrl(new URL(location, url).href, allowedHosts);
    if (result.status === 303 || ((result.status === 301 || result.status === 302) && options.method === 'POST')) {
      options = { ...options, method: 'GET', body: undefined };
      delete options.headers['content-type'];
    }
  }
  throw new Error('Upstream exceeded the redirect limit.');
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > JSON_LIMIT) throw new Error('Request body exceeds the limit.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function parsePayload(data) {
  if (!data || typeof data.url !== 'string' || typeof data.method !== 'string' ||
      !METHODS.has(data.method) || !data.headers || typeof data.headers !== 'object' ||
      Array.isArray(data.headers) || typeof data.body !== 'string')
    throw new Error('Invalid proxy request.');
  const headers = {};
  for (const [name, value] of Object.entries(data.headers)) {
    const key = name.toLowerCase();
    if (!FORWARDED_HEADERS.has(key) || typeof value !== 'string' || /[\r\n]/.test(value))
      throw new Error('Unsupported request header: ' + name);
    headers[key] = value;
  }
  if (data.body.length > Math.ceil(BODY_LIMIT * 4 / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.body))
    throw new Error('Invalid or oversized request body.');
  const body = data.body ? Buffer.from(data.body, 'base64') : undefined;
  if (body && body.length > BODY_LIMIT) throw new Error('Request body exceeds the 16 MiB limit.');
  if ((data.method === 'GET' || data.method === 'HEAD') && body?.length) throw new Error(data.method + ' requests cannot have a body.');
  return { url: data.url, options: { method: data.method, headers, body } };
}

export function createProxyServer({ allowedHosts = [], allowedOrigins = [], upstream = requestPinned, rateLimit = DEFAULT_RATE_LIMIT } = {}) {
  if (!Number.isInteger(rateLimit) || rateLimit < 1) throw new Error('Rate limit must be a positive integer.');
  const hosts = new Set(allowedHosts.map(host => host.toLowerCase()));
  if ([...hosts].some(host => !/^(?=.{1,253}$)[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(host) || isIP(host)))
    throw new Error('Allowed hosts must be exact DNS names, not wildcards or IP addresses.');
  if (allowedOrigins.includes('*') || allowedOrigins.some(origin => {
    try { const url = new URL(origin); return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin; }
    catch { return true; }
  })) throw new Error('Allowed origins must be exact HTTP(S) origins.');
  const origins = new Set(allowedOrigins);
  const clients = new Map();
  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    const corsOrigin = typeof origin === 'string' && origins.has(origin) ? origin : null;
    if (req.method === 'OPTIONS' && req.url === '/v1/fetch') {
      if (!corsOrigin) return response(res, 403, { error: 'Origin is not allowed.' }, null);
      return response(res, 204, null, corsOrigin);
    }
    if (req.method !== 'POST' || req.url !== '/v1/fetch')
      return response(res, 404, { error: 'Not found.' }, corsOrigin);
    if (origin && !corsOrigin) return response(res, 403, { error: 'Origin is not allowed.' }, null);
    const now = Date.now(), client = req.socket.remoteAddress || 'unknown';
    const quota = clients.get(client);
    if (quota && now - quota.start < RATE_WINDOW && quota.count >= rateLimit) {
      res.setHeader('retry-after', String(Math.ceil((RATE_WINDOW - (now - quota.start)) / 1000)));
      return response(res, 429, { error: 'Proxy request rate limit exceeded.' }, corsOrigin);
    }
    if (quota && now - quota.start < RATE_WINDOW) quota.count++;
    else clients.set(client, { start: now, count: 1 });
    if (clients.size > 10000) {
      for (const [ip, entry] of clients) if (now - entry.start >= RATE_WINDOW) clients.delete(ip);
    }
    try {
      const { url, options } = parsePayload(await readJson(req));
      const result = await fetchAllowed(url, options, hosts, upstream);
      response(res, 200, {
        status: result.status, statusText: result.statusText,
        headers: Object.entries(result.headers), body: result.body.toString('base64'),
      }, corsOrigin);
    } catch (error) {
      const status = /allowlist|Origin/.test(error.message) ? 403 :
        /limit|oversized|timed out/.test(error.message) ? 413 : 400;
      response(res, status, { error: error.message || 'Proxy request failed.' }, corsOrigin);
    }
  });
}

const allowedHosts = (process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
if (allowedHosts.length && allowedOrigins.length) {
  const server = createProxyServer({ allowedHosts, allowedOrigins });
  server.listen(Number(process.env.PORT) || 8787, process.env.HOST || '127.0.0.1', () => {
    const address = server.address();
    console.log('Studio HTTP proxy listening on ' + address.address + ':' + address.port);
    console.log('Allowed hosts: ' + allowedHosts.join(', '));
    console.log('Allowed origins: ' + allowedOrigins.join(', '));
  });
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.error('Set ALLOWED_HOSTS and ALLOWED_ORIGINS before starting the proxy.');
  process.exitCode = 2;
}
