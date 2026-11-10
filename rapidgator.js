const { USER_AGENT, delay, requestText } = require('./socks');

function isRapidgatorFile(value) {
  try {
    const url = new URL(value);
    return /(^|\.)rapidgator\.net$/i.test(url.hostname) && /\/file\//i.test(url.pathname);
  } catch {
    return false;
  }
}

function matchGroup(text, pattern) {
  const found = pattern.exec(text);
  return found ? found[1] : '';
}

function stillWaiting(code) {
  const value = String(code || '').toLowerCase();
  return value.includes('wait') || value.includes('try again') || value.includes('specified time');
}

async function rapidgatorJson(proxy, pageUrl, endpoint, params, signal, cookie) {
  const address = new URL(endpoint, pageUrl);
  for (const [key, value] of Object.entries(params)) address.searchParams.set(key, value);
  const result = await requestText(proxy, address.href, {
    signal,
    cookie,
    accept: 'application/json',
    headers: {
      Referer: pageUrl,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
  });
  try {
    return { data: JSON.parse(result.text), cookie: result.cookie, page: result.url };
  } catch {
    throw new Error('Rapidgator returned something that was not a download response.');
  }
}

async function pushRapidgator(proxy, fileUrl, { signal, onWait } = {}) {
  const wait = typeof onWait === 'function' ? onWait : () => {};
  wait(-1);
  const page = await requestText(proxy, fileUrl, { signal, cookie: '' });
  const html = page.text;
  const fid = matchGroup(html, /var\s+fid\s*=\s*(\d+)/);
  if (!fid) throw new Error('Rapidgator did not offer a free download on this page.');

  const parsed = Number(matchGroup(html, /var\s+secs\s*=\s*(\d+)/));
  const seconds = Number.isFinite(parsed) ? Math.min(600, Math.max(0, parsed)) : 80;
  const startPath = matchGroup(html, /var\s+startTimerUrl\s*=\s*'([^']*)'/) || '/download/AjaxStartTimer';
  const linkPath = matchGroup(html, /var\s+getDownloadUrl\s*=\s*'([^']*)'/) || '/download/AjaxGetDownloadLink';
  const captchaPath = matchGroup(html, /var\s+captchaUrl\s*=\s*'([^']*)'/) || '/download/captcha';

  const started = await rapidgatorJson(proxy, page.url, startPath, { fid }, signal, page.cookie);
  const state = String(started.data.state || '');
  if (state.toLowerCase() !== 'started') {
    const code = started.data.code ? ` (${started.data.code})` : '.';
    throw new Error(`Rapidgator did not start the download${code}`);
  }
  const sid = String(started.data.sid || '');
  if (!sid.trim()) throw new Error('Rapidgator did not return a download session.');

  let cookie = started.cookie || page.cookie;
  for (let left = seconds; left > 0; left -= 1) {
    wait(left);
    await delay(1000, signal);
  }

  let refusal = '';
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    wait(0);
    const link = await rapidgatorJson(proxy, page.url, linkPath, { sid }, signal, cookie);
    cookie = link.cookie || cookie;
    if (String(link.data.state || '').toLowerCase() === 'done') {
      return { captchaUrl: new URL(captchaPath, page.url).href, cookie };
    }
    refusal = String(link.data.code || '');
    if (attempt === 12 || !stillWaiting(refusal)) {
      throw new Error(refusal ? `Rapidgator did not open the captcha. ${refusal}` : 'Rapidgator did not open the captcha.');
    }
    await delay(3000, signal);
  }
  throw new Error('Rapidgator did not open the captcha.');
}

module.exports = {
  isRapidgatorFile,
  pushRapidgator,
};
