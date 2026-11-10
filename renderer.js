const links = document.querySelector('#links');
const start = document.querySelector('#start');
const cancel = document.querySelector('#cancel');
const openFolder = document.querySelector('#open-folder');
const summary = document.querySelector('#summary');
const folder = document.querySelector('#folder');
const browse = document.querySelector('#browse');
const parallel = document.querySelector('#parallel');
const reuse = document.querySelector('#reuse');
const jobs = document.querySelector('#jobs');
const untested = document.querySelector('#untested');
const working = document.querySelector('#working');
const fetchButton = document.querySelector('#fetch');
const testButton = document.querySelector('#test');
const testWorkingButton = document.querySelector('#test-working');
const forgetButton = document.querySelector('#forget');
const forgetWorkingButton = document.querySelector('#forget-working');
const bar = document.querySelector('#bar');
const check = document.querySelector('#check');
const counts = document.querySelector('#counts');
const log = document.querySelector('#log');

let saveTimer = 0;
let applying = false;

function formPayload() {
  return {
    links: links.value,
    untested: untested.value,
    working: working.value,
    folder: folder.value.trim(),
    parallel: Number(parallel.value),
    reuse: Number(reuse.value),
  };
}

function setText(box, value) {
  if (box.value === value) return;
  const top = box.scrollTop;
  box.value = value;
  box.scrollTop = top;
}

function setBusy(busy, testing, testingList) {
  start.textContent = busy ? 'Add to queue' : 'Start downloads';
  cancel.disabled = !busy;
  links.readOnly = false;
  start.disabled = testing;
  folder.disabled = busy || testing;
  browse.disabled = busy || testing;
  parallel.disabled = busy || testing;
  reuse.disabled = busy || testing;
  untested.disabled = busy || testing;
  working.disabled = busy || testing;
  fetchButton.disabled = busy || testing;
  forgetButton.disabled = busy || testing;
  forgetWorkingButton.disabled = busy || testing;
  const testingUntested = testing && testingList !== 'working';
  const testingWorking = testing && testingList === 'working';
  testButton.disabled = busy || (testing && !testingUntested);
  testWorkingButton.disabled = busy || (testing && !testingWorking);
  testButton.textContent = testingUntested ? 'Stop test' : 'Test UnTested';
  testWorkingButton.textContent = testingWorking ? 'Stop test' : 'Test Working';
}

function renderJobs(list) {
  jobs.replaceChildren();
  for (const job of list) {
    const row = document.createElement('tr');
    row.className = job.tone || 'yellow';
    const cells = [job.url, job.proxy || '', job.status || '', job.progress || ''];
    for (const [index, value] of cells.entries()) {
      const cell = document.createElement('td');
      if (index === 0) cell.className = 'link';
      cell.textContent = value;
      row.append(cell);
    }
    row.title = 'Double-click to open this captcha window, or the saved file.';
    row.addEventListener('dblclick', () => window.webdl.showJob(job.id));
    jobs.append(row);
  }
}

function renderCounts(payload) {
  const untestedCount = payload.untested ? payload.untested.split(/\r?\n/).filter((line) => line.trim()).length : 0;
  const workingCount = payload.working ? payload.working.split(/\r?\n/).filter((line) => line.trim()).length : 0;
  counts.textContent = `${untestedCount.toLocaleString()} untested, ${workingCount.toLocaleString()} working, ${Number(payload.failedCount || 0).toLocaleString()} rejected`;
}

function applyState(state) {
  applying = true;
  if (state.folder) folder.value = state.folder;
  if (state.parallel) parallel.value = state.parallel;
  if (state.reuse != null) reuse.value = state.reuse;
  setText(untested, state.untested || '');
  setText(working, state.working || '');
  renderCounts(state);
  renderJobs(state.jobs || []);
  summary.textContent = state.summary || 'Idle';
  setBusy(Boolean(state.busy), Boolean(state.testing), state.testingList);
  applying = false;
}

window.webdl.onEvent((event) => {
  if (event.type === 'log') {
    log.textContent += `${event.line}\n`;
    log.scrollTop = log.scrollHeight;
    return;
  }
  if (event.type === 'jobs') {
    renderJobs(event.jobs);
    return;
  }
  if (event.type === 'summary') {
    summary.textContent = event.text;
    return;
  }
  if (event.type === 'proxies') {
    applying = true;
    setText(untested, event.untested || '');
    setText(working, event.working || '');
    renderCounts(event);
    applying = false;
    return;
  }
  if (event.type === 'progress') {
    bar.hidden = !event.testing;
    bar.value = event.percent || 0;
    check.textContent = event.testing
      ? `${event.done.toLocaleString()} / ${event.total.toLocaleString()} (${event.percent}%) · ${event.passed.toLocaleString()} passed · ${event.eta}`
      : '';
    return;
  }
  if (event.type === 'busy') setBusy(Boolean(event.busy), Boolean(event.testing), event.testingList);
});

function rememberProxies() {
  if (applying || untested.disabled) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.webdl.saveProxies({ untested: untested.value, working: working.value });
  }, 500);
}

untested.addEventListener('input', rememberProxies);
working.addEventListener('input', rememberProxies);
folder.addEventListener('change', () => window.webdl.saveSettings(formPayload()));
parallel.addEventListener('change', () => window.webdl.saveSettings(formPayload()));
reuse.addEventListener('change', () => window.webdl.saveSettings(formPayload()));

start.addEventListener('click', async () => {
  const result = await window.webdl.start(formPayload());
  if (result?.clear) links.value = '';
  if (result && !result.ok && result.message) summary.textContent = result.message;
});

cancel.addEventListener('click', () => window.webdl.cancel());
fetchButton.addEventListener('click', () => window.webdl.fetchLists());
async function runTest(list) {
  const result = await window.webdl.test({ ...formPayload(), list });
  if (result && !result.ok && result.message) summary.textContent = result.message;
}

testButton.addEventListener('click', () => runTest('untested'));
testWorkingButton.addEventListener('click', () => runTest('working'));
forgetButton.addEventListener('click', () => window.webdl.forget());
forgetWorkingButton.addEventListener('click', () => window.webdl.forgetWorking());
openFolder.addEventListener('click', () => window.webdl.openFolder(folder.value.trim()));
browse.addEventListener('click', async () => {
  const picked = await window.webdl.pickFolder();
  if (picked) {
    folder.value = picked;
    window.webdl.saveSettings(formPayload());
  }
});

window.webdl.getState().then(applyState);
