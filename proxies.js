const { connectSocks, formatLine, isAbort, parseProxy } = require('./socks');

const SOURCES = [
  ['monosans', 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt'],
  ['Proxifly', 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks5/data.txt'],
  ['TheSpeedX', 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt'],
  ['ProxyScrape', 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text&protocol=socks5'],
  ['ProxyScrape v2', 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all&ssl=all&anonymity=all'],
  ['GitHub Free-Proxy', 'https://raw.githubusercontent.com/dpangestuw/Free-Proxy/refs/heads/main/socks5_proxies.txt'],
  ['hookzof', 'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt'],
  ['jetkai', 'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt'],
  ['prxchk', 'https://raw.githubusercontent.com/prxchk/proxy-list/main/socks5.txt'],
  ['vakhov', 'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks5.txt'],
  ['ShiftyTR', 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt'],
  ['rdavydov', 'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/socks5.txt'],
  ['openproxylist', 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt'],
  ['Anonym0usWork1221', 'https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_files/socks5_proxies.txt'],
  ['zevtyardt', 'https://raw.githubusercontent.com/zevtyardt/proxy-list/main/socks5.txt'],
  ['ErcinDedeoglu', 'https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/socks5.txt'],
];

function parseLines(text) {
  const proxies = [];
  let invalid = 0;
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const proxy = parseProxy(trimmed);
    if (!proxy) {
      invalid += 1;
      continue;
    }
    const key = proxy.display.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    proxies.push(proxy);
  }
  return { proxies, invalid };
}

function linesOf(proxies) {
  return proxies.map(formatLine).join('\n');
}

async function fetchLists(signal) {
  return Promise.all(SOURCES.map(async ([name, url]) => {
    const timeout = AbortSignal.timeout(60000);
    const linked = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch(url, { signal: linked, headers: { 'User-Agent': 'WebDL/1.0' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { name, text: await response.text() };
    } catch (error) {
      const message = error.name === 'TimeoutError' ? 'timed out' : (error.message || 'failed');
      return { name, error: message };
    }
  }));
}

async function testProxies(proxies, { signal, onEach } = {}) {
  if (!proxies.length) return;
  let cursor = 0;
  const workers = Math.min(proxies.length, 512);
  async function worker() {
    while (!signal?.aborted) {
      const index = cursor;
      cursor += 1;
      if (index >= proxies.length) return;
      const proxy = proxies[index];
      let ok = false;
      try {
        const socket = await connectSocks(proxy, '1.1.1.1', 443, { timeoutMs: 3000, signal });
        socket.destroy();
        ok = !signal?.aborted;
      } catch (error) {
        if (isAbort(error)) return;
        ok = false;
      }
      if (signal?.aborted) return;
      onEach?.(proxy, ok);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

module.exports = {
  parseLines,
  linesOf,
  fetchLists,
  testProxies,
};
