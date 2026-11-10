const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const tls = require('tls');
const zlib = require('zlib');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

class SocksError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SocksError';
    this.isProxy = true;
  }
}

class PageChallenge extends Error {
  constructor(pageUrl, cookie) {
    super('The site asked for a captcha.');
    this.pageUrl = pageUrl;
    this.cookie = cookie || '';
  }
}

function abortError() {
  const error = new Error('Stopped');
  error.name = 'AbortError';
  return error;
}

function isAbort(error) {
  return error?.name === 'AbortError';
}

function isProxyDead(error) {
  if (!error || isAbort(error)) return false;
  if (error.statusCode || error.pageUrl || error.skipped) return false;
  if (error.isProxy) return true;
  const code = error.code || '';
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    return true;
  }
  return /timed[_ ]out|timeout|err_tunnel|err_proxy|err_connection|err_name_not_resolved|proxy|socks/i.test(`${error.code || ''} ${error.message || ''}`);
}

function displayHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function parseProxy(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `socks5://${raw}`;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!['socks5:', 'socks5h:', 'socks:'].includes(url.protocol)) return null;
  const port = Number(url.port);
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port,
    username: url.username ? decodeURIComponent(url.username) : '',
    password: url.password ? decodeURIComponent(url.password) : '',
    display: `${displayHost(url.hostname.replace(/^\[|\]$/g, ''))}:${port}`,
  };
}

function addressKey(proxy) {
  return String(proxy?.host || '').trim().toLowerCase();
}

function storedAddressKey(value) {
  const proxy = parseProxy(value);
  if (proxy) return addressKey(proxy);
  return String(value || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').trim().toLowerCase();
}

function formatLine(proxy) {
  if (proxy.username) {
    const user = encodeURIComponent(proxy.username);
    const pass = encodeURIComponent(proxy.password || '');
    return `socks5://${user}:${pass}@${proxy.display}`;
  }
  return proxy.display;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    function finish() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createReader(socket) {
  let buffer = Buffer.alloc(0);
  const waiters = [];
  let failed = null;

  function kick() {
    while (waiters.length) {
      const waiter = waiters[0];
      if (failed && buffer.length < waiter.n) {
        waiters.shift();
        waiter.reject(failed);
        continue;
      }
      if (buffer.length < waiter.n) return;
      const out = buffer.subarray(0, waiter.n);
      buffer = buffer.subarray(waiter.n);
      waiters.shift();
      waiter.resolve(out);
    }
  }

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    kick();
  };
  const onError = (error) => {
    failed = new SocksError(`The proxy closed the connection. ${error.message}`);
    kick();
  };
  const onEnd = () => {
    if (!failed) failed = new SocksError('The proxy closed the connection.');
    kick();
  };
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('end', onEnd);

  return {
    read(n) {
      return new Promise((resolve, reject) => {
        waiters.push({ n, resolve, reject });
        kick();
      });
    },
    detach() {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
      if (buffer.length) socket.unshift(buffer);
    },
  };
}

function connectSocks(proxy, destHost, destPort, { timeoutMs = 20000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    socket.setNoDelay(true);
    let settled = false;
    const timer = setTimeout(() => fail(new SocksError(`Timed out connecting through ${proxy.display}.`)), timeoutMs);
    const onAbort = () => fail(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('error', (error) => fail(new SocksError(`Could not reach proxy ${proxy.display}. ${error.code || error.message}`)));
    socket.once('connect', () => {
      socket.setKeepAlive(true, 10000);
      handshake(socket, proxy, destHost, destPort)
        .then(() => done())
        .catch((error) => fail(error instanceof SocksError ? error : new SocksError(error.message)));
    });

    function done() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.removeAllListeners('error');
      socket.removeAllListeners('connect');
      resolve(socket);
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      reject(error);
    }
  });
}

async function handshake(socket, proxy, destHost, destPort) {
  const reader = createReader(socket);
  try {
    const hasUser = Boolean(proxy.username);
    socket.write(hasUser ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
    const method = await reader.read(2);
    if (method[0] !== 5) throw new SocksError(`Proxy ${proxy.display} did not speak SOCKS5.`);
    if (method[1] === 2) {
      if (!hasUser) throw new SocksError(`Proxy ${proxy.display} requires a username and password.`);
      await authenticate(socket, reader, proxy);
    } else if (method[1] !== 0) {
      throw new SocksError(`Proxy ${proxy.display} rejected the login method.`);
    }

    const address = addressBytes(destHost);
    const request = Buffer.alloc(4 + address.body.length + 2);
    request[0] = 5;
    request[1] = 1;
    request[2] = 0;
    request[3] = address.type;
    address.body.copy(request, 4);
    request.writeUInt16BE(destPort, 4 + address.body.length);
    socket.write(request);

    const reply = await reader.read(4);
    if (reply[0] !== 5) throw new SocksError(`Proxy ${proxy.display} returned an invalid SOCKS5 reply.`);
    if (reply[1] !== 0) {
      throw new SocksError(`Proxy ${proxy.display} could not reach the site (${replyText(reply[1])}).`);
    }
    let remaining = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : -1;
    if (reply[3] === 3) {
      const length = await reader.read(1);
      remaining = length[0];
    } else if (remaining < 0) {
      throw new SocksError(`Proxy ${proxy.display} returned an unknown address type.`);
    }
    await reader.read(remaining + 2);
  } finally {
    reader.detach();
  }
}

async function authenticate(socket, reader, proxy) {
  const user = Buffer.from(proxy.username);
  const pass = Buffer.from(proxy.password || '');
  if (user.length < 1 || user.length > 255 || pass.length > 255) {
    throw new SocksError('The SOCKS5 username or password length is not supported.');
  }
  const packet = Buffer.alloc(3 + user.length + pass.length);
  packet[0] = 1;
  packet[1] = user.length;
  user.copy(packet, 2);
  packet[2 + user.length] = pass.length;
  pass.copy(packet, 3 + user.length);
  socket.write(packet);
  const reply = await reader.read(2);
  if (reply[1] !== 0) throw new SocksError(`Proxy ${proxy.display} rejected the username or password.`);
}

function ipv6Bytes(host) {
  const halves = host.split('::');
  if (halves.length > 2) throw new SocksError('The download address is not a valid IPv6 address.');
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const missing = 8 - (head.length + tail.length);
  const full = [...head, ...Array(Math.max(missing, 0)).fill('0'), ...tail];
  const body = Buffer.alloc(16);
  for (let index = 0; index < 8; index += 1) {
    body.writeUInt16BE(parseInt(full[index] || '0', 16), index * 2);
  }
  return body;
}

function addressBytes(host) {
  if (net.isIP(host) === 4) {
    return { type: 1, body: Buffer.from(host.split('.').map((part) => Number(part))) };
  }
  if (net.isIP(host) === 6) {
    return { type: 4, body: ipv6Bytes(host) };
  }
  const name = Buffer.from(host);
  if (name.length < 1 || name.length > 255) throw new SocksError('The download host name is too long for SOCKS5.');
  return { type: 3, body: Buffer.concat([Buffer.from([name.length]), name]) };
}

function replyText(code) {
  return {
    1: 'general failure',
    2: 'connection not allowed',
    3: 'network unreachable',
    4: 'host unreachable',
    5: 'connection refused',
    6: 'TTL expired',
    7: 'command not supported',
    8: 'address type not supported',
  }[code] || `code ${code}`;
}

function mergeCookieHeader(existing, setCookie) {
  const jar = new Map();
  const store = (pair) => {
    const eq = pair.indexOf('=');
    if (eq <= 0) return;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  };
  if (existing) {
    for (const part of existing.split(';')) store(part.trim());
  }
  const lines = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const line of lines) store(String(line).split(';')[0].trim());
  if (!jar.size) return '';
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function openHttp(proxy, urlString, { method = 'GET', headers = {}, signal, timeoutMs = 45000 } = {}) {
  const url = new URL(urlString);
  const secure = url.protocol === 'https:';
  const lib = secure ? https : http;
  const port = Number(url.port || (secure ? 443 : 80));
  const agent = new lib.Agent({ keepAlive: false });
  agent.createConnection = (_options, callback) => {
    connectSocks(proxy, url.hostname, port, { timeoutMs: Math.min(timeoutMs || 20000, 20000), signal })
      .then((raw) => {
        raw.setKeepAlive(true, 10000);
        if (!secure) {
          callback(null, raw);
          return;
        }
        const wrapped = tls.connect({
          socket: raw,
          servername: url.hostname,
          ALPNProtocols: ['http/1.1'],
        });
        wrapped.once('secureConnect', () => callback(null, wrapped));
        wrapped.once('error', (error) => {
          raw.destroy();
          callback(error);
        });
      })
      .catch((error) => callback(error));
  };

  return new Promise((resolve, reject) => {
    const req = lib.request({
      agent,
      protocol: url.protocol,
      hostname: url.hostname,
      port,
      method,
      path: `${url.pathname || '/'}${url.search}`,
      headers: { ...headers, Host: url.host, Connection: 'close' },
    }, (res) => resolve({ res, agent }));
    const fail = (error) => {
      agent.destroy();
      reject(isAbort(error) || error?.isProxy || error?.statusCode ? error : new SocksError(error.message || 'The proxy connection failed.'));
    };
    req.on('error', fail);
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => req.destroy(new SocksError(`Timed out connecting through ${proxy.display}.`)));
    }
    if (signal) {
      if (signal.aborted) {
        req.destroy(abortError());
      } else {
        signal.addEventListener('abort', () => req.destroy(abortError()), { once: true });
      }
    }
    req.end();
  });
}

function decoded(res) {
  const encoding = String(res.headers['content-encoding'] || '');
  if (/\bgzip\b/i.test(encoding)) return res.pipe(zlib.createGunzip());
  if (/\bbr\b/i.test(encoding)) return res.pipe(zlib.createBrotliDecompress());
  if (/\bdeflate\b/i.test(encoding)) return res.pipe(zlib.createInflate());
  return res;
}

function readStream(stream, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const fail = (error) => reject(error?.isProxy || isAbort(error) ? error : new SocksError(error.message || 'The connection closed.'));
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', fail);
    if (signal?.aborted) {
      stream.destroy(abortError());
    } else {
      signal?.addEventListener('abort', () => stream.destroy(abortError()), { once: true });
    }
  });
}

async function requestText(proxy, url, options = {}) {
  let current = url;
  let cookie = options.cookie || '';
  for (let hop = 0; hop < 10; hop += 1) {
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: options.accept || 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      ...(options.headers || {}),
    };
    if (cookie) headers.Cookie = cookie;
    const opened = await openHttp(proxy, current, {
      method: options.method || 'GET',
      headers,
      signal: options.signal,
      timeoutMs: options.timeoutMs || 45000,
    });
    cookie = mergeCookieHeader(cookie, opened.res.headers['set-cookie']);
    const location = opened.res.headers.location;
    if ([301, 302, 303, 307, 308].includes(opened.res.statusCode) && location) {
      opened.res.resume();
      opened.agent.destroy();
      current = new URL(location, current).href;
      continue;
    }
    const body = await readStream(decoded(opened.res), options.signal);
    opened.agent.destroy();
    if (opened.res.statusCode >= 400) {
      const error = new Error(`The site returned HTTP ${opened.res.statusCode}.`);
      error.statusCode = opened.res.statusCode;
      throw error;
    }
    return { url: current, status: opened.res.statusCode, text: body.toString('utf8'), cookie };
  }
  throw new Error('The site redirected too many times.');
}

function filenameFrom(header, url) {
  const value = String(header || '');
  const star = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return star[1];
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(value);
  if (plain) return plain[1];
  try {
    const base = path.basename(new URL(url).pathname);
    if (base) return decodeURIComponent(base);
  } catch {
    return 'download';
  }
  return 'download';
}

function safeName(name) {
  const cleaned = String(name || 'download').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return (cleaned || 'download').slice(0, 180);
}

function uniquePath(folder, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(folder, name);
  let number = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(folder, `${base} (${number})${ext}`);
    number += 1;
  }
  return candidate;
}

function pipeToFile(res, part, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(part);
    let received = 0;
    const total = Number(res.headers['content-length']) || null;
    let last = 0;
    const fail = (error) => {
      res.destroy();
      file.destroy();
      fs.rm(part, { force: true }, () => reject(error));
    };
    res.on('data', (chunk) => {
      received += chunk.length;
      const now = Date.now();
      if (onProgress && now - last > 400) {
        last = now;
        onProgress(received, total);
      }
    });
    res.on('error', (error) => fail(isAbort(error) || error.isProxy ? error : new SocksError(error.message || 'The connection closed.')));
    file.on('error', fail);
    file.on('finish', () => {
      if (onProgress) onProgress(received, total);
      resolve();
    });
    if (signal?.aborted) fail(abortError());
    else signal?.addEventListener('abort', () => fail(abortError()), { once: true });
    res.pipe(file);
  });
}

async function downloadToFile(proxy, url, folder, { signal, onProgress } = {}) {
  let current = url;
  let cookie = '';
  fs.mkdirSync(folder, { recursive: true });
  for (let hop = 0; hop < 10; hop += 1) {
    const headers = { 'User-Agent': USER_AGENT, Accept: '*/*' };
    if (cookie) headers.Cookie = cookie;
    const opened = await openHttp(proxy, current, { headers, signal, timeoutMs: 0 });
    cookie = mergeCookieHeader(cookie, opened.res.headers['set-cookie']);
    if ([301, 302, 303, 307, 308].includes(opened.res.statusCode) && opened.res.headers.location) {
      opened.res.resume();
      opened.agent.destroy();
      current = new URL(opened.res.headers.location, current).href;
      continue;
    }
    const type = String(opened.res.headers['content-type'] || '');
    if (opened.res.statusCode === 403 || opened.res.statusCode === 429 || opened.res.statusCode === 503 || /text\/html/i.test(type)) {
      opened.res.resume();
      opened.agent.destroy();
      throw new PageChallenge(current, cookie);
    }
    if (opened.res.statusCode >= 400) {
      opened.res.resume();
      opened.agent.destroy();
      const error = new Error(`The site returned HTTP ${opened.res.statusCode}.`);
      error.statusCode = opened.res.statusCode;
      throw error;
    }
    const dest = uniquePath(folder, safeName(filenameFrom(opened.res.headers['content-disposition'], current)));
    const part = `${dest}.part`;
    try {
      await pipeToFile(opened.res, part, signal, onProgress);
    } finally {
      opened.agent.destroy();
    }
    fs.renameSync(part, dest);
    return dest;
  }
  throw new Error('The site redirected too many times.');
}

class SocksBridge {
  constructor(proxy, onStatus) {
    this.proxy = proxy;
    this.onStatus = onStatus;
    this.generation = 0;
    this.live = [];
    this.nextId = 1;
    this.reservations = 0;
    this.waiters = [];
    this.server = net.createServer((socket) => {
      this.handle(socket).catch((error) => {
        if (!isAbort(error) && this.onStatus) this.onStatus(error.message);
        socket.destroy();
      });
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  close() {
    this.generation += 1;
    for (const tunnel of this.live.splice(0)) tunnel.destroy();
    this.server.close();
  }

  async handle(browser) {
    const generation = this.generation;
    browser.setNoDelay(true);
    browser.on('error', () => {});
    const { header, rest } = await readHttpHeader(browser);
    if (generation !== this.generation) {
      browser.destroy();
      return;
    }
    if (rest.length) browser.unshift(rest);
    const line = header.split('\r\n', 1)[0] || '';
    const parts = line.split(' ');
    if (parts.length < 2) {
      browser.destroy();
      return;
    }
    if (/^CONNECT$/i.test(parts[0])) {
      const target = splitHost(parts[1], 443);
      if (!target) {
        browser.destroy();
        return;
      }
      await this.tunnel(browser, target.host, target.port, generation, null);
      return;
    }
    let targetUrl;
    try {
      targetUrl = new URL(parts[1]);
    } catch {
      browser.destroy();
      return;
    }
    const port = targetUrl.port ? Number(targetUrl.port) : targetUrl.protocol === 'https:' ? 443 : 80;
    const rewritten = Buffer.from(`${parts[0]} ${targetUrl.pathname || '/'}${targetUrl.search} HTTP/1.1\r\n${header.slice(line.length + 2)}`);
    await this.tunnel(browser, targetUrl.hostname, port, generation, rewritten);
  }

  async tunnel(browser, host, port, generation, preface) {
    const remote = await this.openRemote(host, port, generation);
    if (!remote) {
      if (generation === this.generation) {
        browser.end('HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nProxy tunnel failed.');
      } else {
        browser.destroy();
      }
      return;
    }
    if (generation !== this.generation) {
      remote.destroy();
      browser.destroy();
      return;
    }
    const tunnel = {
      id: this.nextId,
      host,
      destroy() {
        browser.destroy();
        remote.destroy();
      },
    };
    this.nextId += 1;
    this.live.push(tunnel);
    remote.on('error', () => tunnel.destroy());
    browser.on('error', () => tunnel.destroy());
    if (!preface) browser.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    else remote.write(preface);
    pump(browser, remote);
    pump(remote, browser);
    browser.resume();
    const drop = () => {
      this.live = this.live.filter((item) => item !== tunnel);
    };
    const release = () => {
      drop();
      this.wake();
    };
    browser.on('close', release);
    remote.on('close', release);
  }

  async openRemote(host, port, generation) {
    const reserved = await this.reserve(generation);
    if (!reserved) return null;
    try {
      if (generation !== this.generation) return null;
      let last = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (generation !== this.generation) return null;
        try {
          return await connectSocks(this.proxy, host, port, { timeoutMs: 12000 });
        } catch (error) {
          if (isAbort(error) || generation !== this.generation) return null;
          last = error;
          if (attempt === 1) await delay(400);
        }
      }
      if (last && this.onStatus) {
        this.onStatus(`Could not reach ${host}:${port} through ${this.proxy.display}. ${last.message}`);
      }
      return null;
    } finally {
      this.reservations = Math.max(0, this.reservations - 1);
      this.wake();
    }
  }

  reserve(generation) {
    if (this.reservations < 6) {
      this.reservations += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = (allowed) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((item) => item.done !== done);
        if (allowed && generation === this.generation && this.reservations < 6) {
          this.reservations += 1;
          resolve(true);
          return;
        }
        resolve(false);
      };
      const timer = setTimeout(() => done(false), 20000);
      this.waiters.push({ resolve: () => done(true), done });
    });
  }

  wake() {
    const next = this.waiters.shift();
    if (next) next.resolve(true);
  }
}

function readHttpHeader(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf('\r\n\r\n');
      if (index >= 0) {
        cleanup();
        socket.pause();
        resolve({
          header: buffer.subarray(0, index + 4).toString('latin1'),
          rest: buffer.subarray(index + 4),
        });
      } else if (buffer.length > 65536) {
        cleanup();
        reject(new Error('The browser proxy header is too large.'));
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error('The browser closed the proxy connection.'));
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
  });
}

function splitHost(value, fallbackPort) {
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end <= 1) return null;
    const host = value.slice(1, end);
    const port = value[end + 1] === ':' ? Number(value.slice(end + 2)) : fallbackPort;
    return host && port ? { host, port } : null;
  }
  const colon = value.lastIndexOf(':');
  if (colon > 0 && Number(value.slice(colon + 1))) {
    return { host: value.slice(0, colon), port: Number(value.slice(colon + 1)) };
  }
  return value ? { host: value, port: fallbackPort } : null;
}

function pump(from, to) {
  const onData = (chunk) => {
    if (to.destroyed || to.writableEnded) return;
    const ok = to.write(chunk);
    if (!ok) from.pause();
  };
  from.on('data', onData);
  to.on('drain', () => {
    if (!from.destroyed) from.resume();
  });
  from.on('end', () => {
    if (!to.destroyed && !to.writableEnded) to.end();
  });
  from.on('error', () => {
    if (!to.destroyed) to.destroy();
  });
}

module.exports = {
  USER_AGENT,
  SocksError,
  PageChallenge,
  abortError,
  isAbort,
  isProxyDead,
  parseProxy,
  formatLine,
  addressKey,
  storedAddressKey,
  delay,
  connectSocks,
  requestText,
  downloadToFile,
  SocksBridge,
  safeName,
  uniquePath,
  filenameFrom,
};
