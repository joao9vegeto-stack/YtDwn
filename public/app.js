const socket = io();
const STORAGE_KEY = 'ytdown_jobs_v8';
const downloadsRoot = document.getElementById('downloads');
const startBtn = document.getElementById('startBtn');
const clearBtn = document.getElementById('clear-history');
const modal = document.getElementById('report-modal');
const reportTitle = document.getElementById('report-title');
const reportBody = document.getElementById('report-body');

let store = loadStore();
let cards = {};
let pollers = {};
let busy = false;

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveStore() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {}
}

function uuidLike() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function refreshBusy() {
  busy = Object.values(store).some((job) => !['finished', 'error'].includes(job.stage));
  startBtn.disabled = busy;
  startBtn.textContent = busy ? 'Processando...' : 'Baixar e Converter';
}

function clearDownloads() {
  Object.values(pollers).forEach(clearInterval);
  pollers = {};
  store = {};
  cards = {};
  downloadsRoot.innerHTML = '';
  saveStore();
  refreshBusy();
}

function persist(job) {
  if (!job || !job.id) return;
  const prev = store[job.id] || {};
  store[job.id] = {
    ...prev,
    ...job,
    startedAt: prev.startedAt || job.startedAt || Date.now(),
    updatedAt: Date.now()
  };
  saveStore();
  refreshBusy();
}

function getCard(jobId) {
  if (cards[jobId]) return cards[jobId];
  const el = document.createElement('article');
  el.className = 'download-item';
  el.dataset.jobId = jobId;
  el.innerHTML = `
    <div class="thumb"><img alt=""></div>
    <div class="download-content">
      <div class="badge">H264</div>
      <div class="video-title">Preparando download...</div>
      <div class="status-text"></div>
      <div class="progress-wrap"><div class="progress-bar"></div></div>
      <div class="download-actions"></div>
    </div>
  `;
  downloadsRoot.prepend(el);
  cards[jobId] = el;
  return el;
}

function stageLabel(job) {
  if (job.stage === 'starting') return 'Preparando download...';
  if (job.stage === 'downloading') return `Baixando... ${Math.round(job.progress || 0)}%`;
  if (job.stage === 'processing') return `Mesclando formatos... ${Math.round(job.progress || 0)}%`;
  if (job.stage === 'finished' || job.done) return 'Concluído';
  if (job.stage === 'error' || job.error) return job.error || 'Erro';
  return 'Processando...';
}

function updateCard(job) {
  const el = getCard(job.id);
  const img = el.querySelector('img');
  const titleEl = el.querySelector('.video-title');
  const statusEl = el.querySelector('.status-text');
  const bar = el.querySelector('.progress-bar');
  const actions = el.querySelector('.download-actions');

  if (job.thumbnail) img.src = job.thumbnail;
  if (job.title) titleEl.textContent = job.title;

  const p = Math.max(0, Math.min(100, Number(job.progress || 0)));
  const speed = job.speed || '--';
  const eta = job.eta || '--';

  if (job.stage === 'starting') {
    statusEl.innerHTML = `Preparando download...<br>${speed} • ETA ${eta}`;
    bar.style.width = '0%';
    actions.innerHTML = '';
  } else if (job.stage === 'downloading') {
    statusEl.innerHTML = `Baixando... ${p}%<br>${speed} • ETA ${eta}`;
    bar.style.width = `${p}%`;
    actions.innerHTML = '';
  } else if (job.stage === 'processing') {
    statusEl.innerHTML = `Mesclando formatos...<br>${p}% concluído • ETA ${eta}`;
    bar.style.width = `${p}%`;
    actions.innerHTML = '';
  } else if (job.stage === 'finished' || job.done) {
    statusEl.innerHTML = `<span class="done">Concluído</span>`;
    bar.style.width = '100%';
    actions.innerHTML = `
      <a class="download-btn" href="${job.file || `/api/file/${job.id}`}" download>Baixar MP4</a>
      <button class="download-btn small-btn" type="button" data-report="${job.id}">Relatório MP4</button>
    `;
  } else if (job.stage === 'error' || job.error) {
    statusEl.innerHTML = `<span class="error">${job.error || 'Erro ao processar vídeo'}</span>`;
    actions.innerHTML = '';
  }

  const reportBtn = actions.querySelector('[data-report]');
  if (reportBtn) {
    reportBtn.onclick = () => openReport(job.id, job.title || 'Relatório do MP4');
  }
}

function stopPoll(jobId) {
  if (pollers[jobId]) {
    clearInterval(pollers[jobId]);
    delete pollers[jobId];
  }
}

async function pollJob(jobId) {
  try {
    const res = await fetch(`/api/status/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
    if (!res.ok) {
      if (store[jobId] && !['finished', 'error'].includes(store[jobId].stage)) {
        store[jobId].stage = 'error';
        store[jobId].error = 'Job não encontrado';
        updateCard(store[jobId]);
        persist(store[jobId]);
      }
      stopPoll(jobId);
      return;
    }
    const data = await res.json();
    const merged = { ...(store[jobId] || {}), ...data };
    updateCard(merged);
    persist(merged);
    if (data.stage === 'finished' || data.done || data.error) stopPoll(jobId);
  } catch (err) {
    console.error(err);
  }
}

function startPoll(jobId) {
  stopPoll(jobId);
  pollJob(jobId);
  pollers[jobId] = setInterval(() => pollJob(jobId), 1000);
}

async function startDownload() {
  if (busy) return;
  const url = document.getElementById('url').value.trim();
  const quality = document.getElementById('quality').value;
  if (!url) {
    alert('Cole um link');
    return;
  }

  const clientId = uuidLike();
  const job = {
    id: clientId,
    title: 'Preparando download...',
    thumbnail: '',
    stage: 'starting',
    progress: 0,
    speed: 'Conectando...',
    eta: '--',
    done: false,
    file: '',
    error: '',
    startedAt: Date.now()
  };

  updateCard(job);
  persist(job);

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, quality, clientId })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      job.stage = 'error';
      job.error = data.error || 'Erro ao iniciar download';
      updateCard(job);
      persist(job);
      return;
    }

    const jobId = data.id || clientId;
    job.id = jobId;
    persist(job);
    updateCard(job);
    startPoll(jobId);
  } catch (err) {
    console.error(err);
    job.stage = 'error';
    job.error = 'Erro ao iniciar download';
    updateCard(job);
    persist(job);
  }
}

async function openReport(jobId, title) {
  reportTitle.textContent = title || 'Relatório do MP4';
  reportBody.textContent = 'Carregando...';
  modal.classList.remove('hidden');

  try {
    const res = await fetch(`/api/report/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || data.error) {
      reportBody.textContent = data.error || 'Não foi possível gerar o relatório.';
      return;
    }

    reportBody.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    reportBody.textContent = err.message || 'Erro ao carregar relatório.';
  }
}

function closeModal() {
  modal.classList.add('hidden');
}

socket.on('progress', (data) => {
  if (!data || !data.id) return;
  const merged = { ...(store[data.id] || {}), ...data };
  updateCard(merged);
  persist(merged);
  if (!['finished', 'error'].includes(merged.stage)) startPoll(merged.id);
  if (merged.stage === 'finished' || merged.done || merged.error) stopPoll(merged.id);
});

modal.addEventListener('click', (e) => {
  if (e.target && e.target.hasAttribute('data-close-modal')) closeModal();
});

document.getElementById('startBtn').addEventListener('click', startDownload);
clearBtn.addEventListener('click', clearDownloads);

(function bootstrap() {
  const jobs = Object.values(store).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  jobs.forEach((job) => {
    updateCard(job);
    if (!['finished', 'error'].includes(job.stage)) startPoll(job.id);
  });
  refreshBusy();
})();
  </script>
</body>
</html>
