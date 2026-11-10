const { setMaxListeners } = require('events');
const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fetchLists, linesOf, parseLines, testProxies } = require('./proxies');
const { isRapidgatorFile, pushRapidgator } = require('./rapidgator');
const {
  PageChallenge,
  SocksBridge,
  SocksError,
  USER_AGENT,
  abortError,
  downloadToFile,
  formatLine,
  isAbort,
  isProxyDead,
  safeName,
  uniquePath,
} = require('./socks');

app.userAgentFallback = USER_AGENT;
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-webgl');
app.commandLine.appendSwitch('disable-features', 'ThirdPartyStoragePartitioning,TrackingProtection3pcd');

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const proxyPath = () => path.join(app.getPath('userData'), 'proxies.json');

let mainWindow = null;
let jobs = [];
let proxies = { untested: [], working: [], failed: new Set() };
let settings = defaultSettings();
let sessionRun = null;
let testing = false;
let testAbort = null;
let openCaptcha = null;
let captchaTail = Promise.resolve();
let progressTimer = null;

function stopSignal() {
  const controller = new AbortController();
  setMaxListeners(0, controller.signal);
  return controller;
}

function browserFailure(proxy, error) {
  if (!error || error.skipped || isAbort(error) || error.isProxy) return error;
  const text = `${error.code || ''} ${error.message || ''}`;
  if (/ERR_ABORTED/.test(text)) return null;
  if (/TIMED_OUT|TUNNEL|PROXY|CONNECTION_|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|EMPTY_RESPONSE|INTERNET_DISCONNECTED|SOCKS/i.test(text)) {
    return new SocksError(`The captcha page did not open through ${proxy.display}.`);
  }
  return error;
}

async function captchaState(win) {
  if (!win || win.isDestroyed()) return 'pending';
  const root = win.webContents.mainFrame;
  if (!root) return 'pending';
  const frames = [root, ...(root.framesInSubtree || [])];
  const chunks = [];
  for (const frame of frames) {
    try {
      chunks.push(await frame.executeJavaScript('document.body ? document.body.innerText : ""', true));
    } catch {
      // A frame from another site cannot be read.
    }
  }
  const text = chunks.join('\n');
  if (/select all|verify you are human|i'm not a robot|press and hold/i.test(text)) return 'challenge';
  if (/verification code is incorrect|verification failed/i.test(text)) return 'failed';
  return 'pending';
}

function defaultSettings() {
  return {
    folder: path.join(os.homedir(), 'Downloads', 'WebDL'),
    parallel: 6,
    reuse: 0,
  };
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function send(event) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('event', event);
}

function log(line) {
  const stamp = new Date().toLocaleTimeString();
  send({ type: 'log', line: `[${stamp}] ${line}` });
}

function formatBytes(value) {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function proxyView() {
  return {
    untested: linesOf(proxies.untested),
    working: linesOf(proxies.working),
    failedCount: proxies.failed.size,
  };
}

function snapshot() {
  return {
    ...settings,
    ...proxyView(),
    jobs,
    busy: Boolean(sessionRun),
    testing,
    summary: summaryText(),
  };
}

function summaryText() {
  if (!jobs.length) return sessionRun ? 'Running' : 'Idle';
  let active = 0;
  let saved = 0;
  let stopped = 0;
  for (const job of jobs) {
    if (job.tone === 'green') saved += 1;
    else if (job.tone === 'red') stopped += 1;
    else active += 1;
  }
  return `${active} active, ${saved} saved, ${stopped} stopped`;
}

function refreshSummary() {
  send({ type: 'summary', text: summaryText() });
}

function sendJobs() {
  send({ type: 'jobs', jobs });
  refreshSummary();
}

function sendProxies() {
  send({ type: 'proxies', ...proxyView() });
}

function sendBusy() {
  send({ type: 'busy', busy: Boolean(sessionRun), testing });
}

function markJob(job, patch) {
  Object.assign(job, patch);
  sendJobs();
}

function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    settings = {
      folder: data.folder || defaultSettings().folder,
      parallel: clamp(data.parallel, 1, 30, 6),
      reuse: clamp(data.reuse, 0, 3600, 0),
    };
  } catch {
    settings = defaultSettings();
  }
}

function saveSettings(next = settings) {
  settings = {
    folder: next.folder || defaultSettings().folder,
    parallel: clamp(next.parallel, 1, 30, settings.parallel),
    reuse: clamp(next.reuse, 0, 3600, settings.reuse),
  };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

function loadProxies() {
  try {
    const data = JSON.parse(fs.readFileSync(proxyPath(), 'utf8'));
    const failed = new Set((data.Failed || []).map((item) => String(item).toLowerCase()));
    const working = parseLines((data.Working || []).join('\n')).proxies;
    for (const proxy of working) failed.delete(proxy.display.toLowerCase());
    const workingKeys = new Set(working.map((proxy) => proxy.display.toLowerCase()));
    const untested = parseLines((data.Untested || []).join('\n')).proxies.filter((proxy) => {
      const key = proxy.display.toLowerCase();
      return !failed.has(key) && !workingKeys.has(key);
    });
    proxies = { untested, working, failed };
  } catch {
    proxies = { untested: [], working: [], failed: new Set() };
  }
}

function saveProxyFile() {
  const body = {
    Untested: proxies.untested.map(formatLine),
    Working: proxies.working.map(formatLine),
    Failed: [...proxies.failed],
  };
  fs.mkdirSync(path.dirname(proxyPath()), { recursive: true });
  const temporary = `${proxyPath()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(body, null, 2));
  fs.renameSync(temporary, proxyPath());
}

function applyProxyText(untestedText, workingText) {
  if (sessionRun || testing) return;
  const working = parseLines(workingText).proxies;
  const workingKeys = new Set(working.map((proxy) => proxy.display.toLowerCase()));
  for (const key of workingKeys) proxies.failed.delete(key);
  const untested = parseLines(untestedText).proxies.filter((proxy) => !workingKeys.has(proxy.display.toLowerCase()));
  proxies.untested = untested.filter((proxy) => !proxies.failed.has(proxy.display.toLowerCase()));
  proxies.working = working;
  saveProxyFile();
}

function forgetWorking(proxy) {
  const key = proxy.display.toLowerCase();
  proxies.working = proxies.working.filter((item) => item.display.toLowerCase() !== key);
  proxies.failed.add(key);
  saveProxyFile();
  sendProxies();
  log(`${proxy.display} was removed from the working list.`);
}

function extractLinks(text) {
  const found = String(text || '').match(/https?:\/\/[^\s<>"']+/gi) || [];
  return [...new Set(found.map((link) => link.replace(/[),.;]+$/g, '')))];
}

function makeJob(url) {
  return {
    id: crypto.randomUUID(),
    url,
    proxy: '',
    status: 'Queued',
    progress: 'Queued',
    filePath: '',
    tone: 'yellow',
  };
}

class JobQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }

  get size() {
    return this.items.length;
  }

  push(job) {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter(job);
    else this.items.push(job);
    return true;
  }

  pop() {
    if (this.items.length) return Promise.resolve(this.items.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const leftover = this.items.splice(0);
    for (const job of leftover) {
      if (job.tone !== 'green') markJob(job, { status: 'Stopped', progress: 'Stopped', tone: 'red' });
    }
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }
}

class ProxyPool {
  constructor(list) {
    this.free = list.map((proxy) => ({ proxy, discarded: false }));
    this.waiters = [];
    this.alive = this.free.length;
  }

  rent(signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.free.length) return Promise.resolve(this.free.shift());
    if (this.alive <= 0) return Promise.reject(new Error('No working proxies left'));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  release(entry, delayMs) {
    if (!entry || entry.discarded) return;
    const give = () => {
      if (entry.discarded) return;
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(entry);
      else this.free.push(entry);
    };
    if (delayMs > 0) setTimeout(give, delayMs);
    else give();
  }

  discard(entry) {
    entry.discarded = true;
    this.alive -= 1;
    if (this.alive <= 0) {
      const waiters = this.waiters.splice(0);
      for (const waiter of waiters) waiter.reject(new Error('No working proxies left'));
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 980,
    minWidth: 860,
    minHeight: 700,
    title: 'WebDL',
    backgroundColor: '#e7ebf0',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.log(`renderer: ${message}`);
  });
  mainWindow.webContents.once('did-finish-load', () => {
    console.log('WebDL window ready');
    log('WebDL ready.');
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function showCaptcha({ proxy, url, cookie, folder, signal, job }) {
  const result = captchaTail.then(() => openCaptchaWindow({ proxy, url, cookie, folder, signal, job }));
  captchaTail = result.then(() => {}, () => {});
  return result;
}

function openCaptchaWindow({ proxy, url, cookie, folder, signal, job }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const bridge = new SocksBridge(proxy, (message) => log(message));
    let settled = false;
    let win = null;
    let watch = null;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      if (watch) clearInterval(watch);
      signal?.removeEventListener('abort', onAbort);
      try {
        bridge.close();
      } catch {
        // The bridge is already stopped.
      }
      if (win && !win.isDestroyed()) win.close();
      if (openCaptcha === win) openCaptcha = null;
      settle(value);
    };
    const onAbort = () => finish(reject, abortError());
    signal?.addEventListener('abort', onAbort, { once: true });

    bridge.start().then(async (port) => {
      const partition = session.fromPartition(`captcha-${job.id}`);
      await partition.setProxy({
        mode: 'fixed_servers',
        proxyRules: `http=127.0.0.1:${port};https=127.0.0.1:${port}`,
        proxyBypassRules: '<local>',
      });
      await partition.closeAllConnections();
      partition.setUserAgent(USER_AGENT);
      await applyCookies(partition, cookie);
      partition.on('will-download', (_event, item) => {
        const name = safeName(item.getFilename() || 'download');
        fs.mkdirSync(folder, { recursive: true });
        const dest = uniquePath(folder, name);
        item.setSavePath(dest);
        markJob(job, { status: 'Downloading', progress: `Saving ${name}`, tone: 'yellow' });
        let last = 0;
        item.on('updated', () => {
          const now = Date.now();
          if (now - last < 400) return;
          last = now;
          const got = item.getReceivedBytes();
          const total = item.getTotalBytes();
          const progress = total > 0
            ? `Saving ${name} (${formatBytes(got)} / ${formatBytes(total)})`
            : `Saving ${name} (${formatBytes(got)})`;
          markJob(job, { progress, tone: 'yellow', status: 'Downloading' });
        });
        item.once('done', (_eventDone, state) => {
          if (state === 'completed') finish(resolve, dest);
          else finish(reject, new Error(`The download stopped (${state}).`));
        });
      });

      win = new BrowserWindow({
        width: 1040,
        height: 780,
        title: `Solve captcha — ${proxy.display}`,
        backgroundColor: '#ffffff',
        autoHideMenuBar: true,
        webPreferences: {
          session: partition,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: false,
          webgl: true,
          backgroundThrottling: false,
        },
      });
      openCaptcha = win;
      let failedAt = 0;
      let warned = false;
      const look = async () => {
        if (settled) return;
        const state = await captchaState(win);
        if (state !== 'failed') {
          failedAt = 0;
          return;
        }
        if (!failedAt) failedAt = Date.now();
        if (!warned && win && !win.isDestroyed()) {
          warned = true;
          win.setTitle('Click the captcha box to load the pictures.');
          log(`Captcha failed the automatic check on ${proxy.display}. Click the box if the pictures appear.`);
        }
        if (Date.now() - failedAt < 20000) return;
        log(`Captcha stayed failed on ${proxy.display}. Removing it and starting that file again.`);
        finish(reject, new SocksError(`Captcha verification failed through ${proxy.display}.`));
      };
      watch = setInterval(look, 1500);
      win.webContents.on('did-finish-load', () => {
        setTimeout(look, 800);
      });
      win.on('closed', () => {
        if (openCaptcha === win) openCaptcha = null;
        const skipped = new Error('Skipped');
        skipped.skipped = true;
        finish(reject, skipped);
      });
      win.webContents.setWindowOpenHandler(({ url: next }) => {
        if (win && !win.isDestroyed()) win.loadURL(next).catch(() => {});
        return { action: 'deny' };
      });
      win.webContents.on('did-fail-load', (_event, code, description, _failedUrl, isMainFrame) => {
        if (!isMainFrame) return;
        if (code === -3) {
          if (win && !win.isDestroyed()) win.setTitle('The file should start saving now.');
          return;
        }
        log(`Captcha page did not load (${description}).`);
        if (win && !win.isDestroyed()) win.setTitle(`Page did not load (${description}).`);
        const failure = browserFailure(proxy, { code: description, message: description });
        if (failure?.isProxy) finish(reject, failure);
      });
      log(`Captcha ${url} through ${proxy.display}`);
      try {
        await win.loadURL(url);
        if (!win.isDestroyed()) win.setTitle('Submit the captcha, then click the download button.');
      } catch (error) {
        const failure = browserFailure(proxy, error);
        if (!failure) return;
        finish(reject, failure instanceof Error ? failure : new Error('The captcha window did not open.'));
      }
    }).catch((error) => finish(reject, error));
  });
}

async function applyCookies(partition, cookieHeader) {
  if (!cookieHeader) return;
  for (const part of cookieHeader.split(';')) {
    const piece = part.trim();
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    try {
      await partition.cookies.set({
        url: 'https://rapidgator.net/',
        name: piece.slice(0, eq).trim(),
        value: piece.slice(eq + 1).trim(),
        path: '/',
        secure: true,
      });
    } catch {
      // Skip a cookie the browser will not store.
    }
  }
}

async function downloadJob(run, job, proxy) {
  if (isRapidgatorFile(job.url)) {
    const gate = await pushRapidgator(proxy, job.url, {
      signal: run.signal,
      onWait: (left) => {
        const progress = left < 0 ? 'Opening Rapidgator' : left === 0 ? 'Getting the captcha link' : `Waiting ${left}s`;
        markJob(job, { status: 'Downloading', progress, tone: 'yellow' });
      },
    });
    markJob(job, { status: 'Downloading', progress: 'Waiting for captcha', tone: 'yellow' });
    return showCaptcha({
      proxy,
      url: gate.captchaUrl,
      cookie: gate.cookie,
      folder: run.folder,
      signal: run.signal,
      job,
    });
  }

  try {
    return await downloadToFile(proxy, job.url, run.folder, {
      signal: run.signal,
      onProgress: (got, total) => {
        const progress = total ? `${formatBytes(got)} / ${formatBytes(total)}` : formatBytes(got);
        markJob(job, { status: 'Downloading', progress, tone: 'yellow' });
      },
    });
  } catch (error) {
    if (!(error instanceof PageChallenge)) throw error;
    markJob(job, { status: 'Downloading', progress: 'Waiting for captcha', tone: 'yellow' });
    return showCaptcha({
      proxy,
      url: error.pageUrl,
      cookie: error.cookie,
      folder: run.folder,
      signal: run.signal,
      job,
    });
  }
}

async function execute(run, job) {
  while (!run.signal.aborted) {
    let entry;
    try {
      markJob(job, { status: 'Downloading', progress: 'Waiting for a proxy', tone: 'yellow' });
      entry = await run.pool.rent(run.signal);
    } catch (error) {
      if (isAbort(error) || run.signal.aborted) {
        markJob(job, { status: 'Stopped', progress: 'Stopped', tone: 'red' });
        return;
      }
      markJob(job, { status: 'Failed', progress: 'No working proxies left', tone: 'red' });
      log(`${job.url} failed. No working proxies left.`);
      return;
    }

    markJob(job, { proxy: entry.proxy.display, status: 'Downloading', progress: 'Connecting', tone: 'yellow' });
    log(`${entry.proxy.display} → ${job.url}`);
    try {
      const saved = await downloadJob(run, job, entry.proxy);
      markJob(job, { status: 'Saved', progress: 'Saved', tone: 'green', filePath: saved });
      log(`Saved ${saved}`);
      run.pool.release(entry, run.reuse * 1000);
      return;
    } catch (error) {
      if (isAbort(error) || run.signal.aborted) {
        run.pool.release(entry, 0);
        markJob(job, { status: 'Stopped', progress: 'Stopped', tone: 'red' });
        return;
      }
      if (error.skipped) {
        run.pool.release(entry, 0);
        markJob(job, { status: 'Stopped', progress: 'Skipped', tone: 'red' });
        log(`Skipped ${job.url}`);
        return;
      }
      if (isProxyDead(error)) {
        log(`${entry.proxy.display} failed. ${error.message}`);
        forgetWorking(entry.proxy);
        run.pool.discard(entry);
        markJob(job, { status: 'Downloading', progress: 'Switching proxy', tone: 'yellow' });
        continue;
      }
      run.pool.release(entry, run.reuse * 1000);
      markJob(job, { status: 'Failed', progress: error.message || 'Failed', tone: 'red' });
      log(`${job.url} failed. ${error.message}`);
      return;
    }
  }
  markJob(job, { status: 'Stopped', progress: 'Stopped', tone: 'red' });
}

function finishSession(run) {
  if (run.finished || sessionRun !== run || run.active > 0 || run.queue.size > 0) return;
  run.finished = true;
  sessionRun = null;
  run.queue.close();
  sendBusy();
  refreshSummary();
  log(run.controller.signal.aborted ? 'Queue stopped.' : 'Queue finished.');
}

function runWorkers(run) {
  const count = clamp(run.parallel, 1, 30, 6);
  const worker = async () => {
    try {
      for (;;) {
        const job = await run.queue.pop();
        if (!job) {
          finishSession(run);
          return;
        }
        run.active += 1;
        sendBusy();
        try {
          await execute(run, job);
        } finally {
          run.active -= 1;
          finishSession(run);
        }
      }
    } catch (error) {
      log(error.message || 'A download worker stopped.');
      finishSession(run);
    }
  };
  for (let index = 0; index < count; index += 1) worker();
}

function onStart(payload) {
  const links = extractLinks(payload?.links);
  if (!links.length) return { ok: false, message: 'Paste one http or https link.' };
  if (testing) return { ok: false, message: 'Wait until the proxy test finishes.' };
  saveSettings({
    folder: payload.folder,
    parallel: payload.parallel,
    reuse: payload.reuse,
  });

  if (sessionRun) {
    if (sessionRun.queue.closed) {
      return { ok: false, message: 'The queue just finished. Click Start downloads again.' };
    }
    const created = links.map(makeJob);
    jobs.push(...created);
    for (const job of created) sessionRun.queue.push(job);
    sendJobs();
    log(`Added ${created.length} link${created.length === 1 ? '' : 's'} to the queue.`);
    return { ok: true, clear: true };
  }

  applyProxyText(payload.untested, payload.working);
  if (!proxies.working.length) {
    return { ok: false, message: 'Downloads use the working list. Test proxies first.' };
  }
  fs.mkdirSync(settings.folder, { recursive: true });
  const created = links.map(makeJob);
  jobs.push(...created);
  const controller = stopSignal();
  const run = {
    controller,
    signal: controller.signal,
    queue: new JobQueue(),
    pool: new ProxyPool(proxies.working),
    folder: settings.folder,
    parallel: settings.parallel,
    reuse: settings.reuse,
    active: 0,
    finished: false,
  };
  sessionRun = run;
  for (const job of created) run.queue.push(job);
  sendJobs();
  sendBusy();
  log(`Started ${created.length} download${created.length === 1 ? '' : 's'}.`);
  runWorkers(run);
  return { ok: true, clear: true };
}

function onCancel() {
  const run = sessionRun;
  if (!run) return { ok: true };
  run.controller.abort();
  run.queue.close();
  if (openCaptcha && !openCaptcha.isDestroyed()) openCaptcha.close();
  log('Cancel requested.');
  return { ok: true };
}

async function onFetch() {
  if (sessionRun || testing) return { ok: false, message: 'Wait until the current work finishes.' };
  const controller = stopSignal();
  log('Fetching free proxy lists.');
  try {
    const results = await fetchLists(controller.signal);
    const known = new Set([
      ...proxies.untested.map((proxy) => proxy.display.toLowerCase()),
      ...proxies.working.map((proxy) => proxy.display.toLowerCase()),
      ...proxies.failed,
    ]);
    let added = 0;
    const warnings = [];
    for (const result of results) {
      if (result.error) {
        warnings.push(`${result.name}: ${result.error}`);
        continue;
      }
      for (const proxy of parseLines(result.text).proxies) {
        const key = proxy.display.toLowerCase();
        if (known.has(key)) continue;
        known.add(key);
        proxies.untested.push(proxy);
        added += 1;
      }
    }
    saveProxyFile();
    sendProxies();
    log(`Fetched ${added.toLocaleString()} new proxies.`);
    for (const warning of warnings) log(warning);
    return { ok: true };
  } catch (error) {
    log(`Fetch failed. ${error.message}`);
    return { ok: false, message: error.message };
  }
}

function etaText(done, total, started) {
  if (done < 1) return 'ETA …';
  const seconds = Math.max(0, Math.round((((Date.now() - started) / done) * (total - done)) / 1000));
  if (seconds < 60) return `ETA ${seconds}s`;
  return `ETA ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function emitProgress(done, total, passed, started, active) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  send({
    type: 'progress',
    testing: active,
    done,
    total,
    passed,
    percent,
    eta: active ? etaText(done, total, started) : '',
  });
}

async function onTest(payload) {
  if (sessionRun) return { ok: false, message: 'Wait until the downloads finish.' };
  if (testing && testAbort) {
    testAbort.abort();
    return { ok: true };
  }
  applyProxyText(payload?.untested, payload?.working);
  const pending = [...proxies.untested];
  if (!pending.length) return { ok: false, message: 'The untested list is empty.' };

  testing = true;
  testAbort = stopSignal();
  sendBusy();
  const started = Date.now();
  let done = 0;
  let passed = 0;
  const total = pending.length;
  emitProgress(0, total, 0, started, true);
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    emitProgress(done, total, passed, started, true);
    sendProxies();
  }, 400);
  log(`Testing ${total.toLocaleString()} proxies.`);

  try {
    await testProxies(pending, {
      signal: testAbort.signal,
      onEach: (proxy, ok) => {
        done += 1;
        const key = proxy.display.toLowerCase();
        proxies.untested = proxies.untested.filter((item) => item.display.toLowerCase() !== key);
        if (ok) {
          passed += 1;
          proxies.failed.delete(key);
          if (!proxies.working.some((item) => item.display.toLowerCase() === key)) proxies.working.push(proxy);
        } else {
          proxies.failed.add(key);
        }
      },
    });
  } finally {
    clearInterval(progressTimer);
    progressTimer = null;
    const stopped = testAbort.signal.aborted;
    testing = false;
    testAbort = null;
    saveProxyFile();
    sendProxies();
    emitProgress(done, total, passed, started, false);
    sendBusy();
    log(stopped ? `Proxy test stopped. ${passed.toLocaleString()} passed.` : `Proxy test finished. ${passed.toLocaleString()} passed.`);
  }
  return { ok: true };
}

function registerIpc() {
  ipcMain.handle('state:get', () => snapshot());
  ipcMain.handle('downloads:start', (_event, payload) => onStart(payload));
  ipcMain.handle('downloads:cancel', () => onCancel());
  ipcMain.handle('proxies:fetch', () => onFetch());
  ipcMain.handle('proxies:test', (_event, payload) => onTest(payload));
  ipcMain.handle('proxies:forget', () => {
    if (sessionRun || testing) return { ok: false, message: 'Wait until the current work finishes.' };
    proxies.failed.clear();
    saveProxyFile();
    sendProxies();
    log('Forgot rejected proxies.');
    return { ok: true };
  });
  ipcMain.handle('proxies:forget-working', () => {
    if (sessionRun || testing) return { ok: false, message: 'Wait until the current work finishes.' };
    const count = proxies.working.length;
    proxies.working = [];
    saveProxyFile();
    sendProxies();
    log(`Forgot ${count.toLocaleString()} working proxies.`);
    return { ok: true };
  });
  ipcMain.handle('proxies:save', (_event, payload) => {
    applyProxyText(payload?.untested, payload?.working);
    return { ok: true };
  });
  ipcMain.handle('settings:save', (_event, payload) => {
    if (sessionRun || testing) return { ok: false };
    saveSettings(payload || {});
    return { ok: true, ...settings };
  });
  ipcMain.handle('folder:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return '';
    return result.filePaths[0];
  });
  ipcMain.handle('folder:open', (_event, folder) => {
    const target = folder || settings.folder;
    fs.mkdirSync(target, { recursive: true });
    return shell.openPath(target);
  });
  ipcMain.handle('file:open', (_event, file) => shell.openPath(file));
}

app.whenReady().then(() => {
  loadSettings();
  loadProxies();
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  if (sessionRun) sessionRun.controller.abort();
  app.quit();
});
