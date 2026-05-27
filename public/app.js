
const STORAGE_KEY = "ytdown_jobs_v8";

const downloadsRoot = document.getElementById("downloads");
const urlInput = document.getElementById("url");
const qualityInput = document.getElementById("quality");
const startBtn = document.getElementById("start-btn");
const clearBtn = document.getElementById("clear-history");
const reportModal = document.getElementById("report-modal");
const reportBody = document.getElementById("report-body");
const reportSubtitle = document.getElementById("report-subtitle");

let store = loadStore();
let cards = Object.create(null);
let pollers = Object.create(null);

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveStore() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function activeJobsExist() {
  return Object.values(store).some((job) => !["finished", "error"].includes(job.stage));
}

function syncButtonState() {
  const active = activeJobsExist();
  startBtn.disabled = active;
  startBtn.textContent = active ? "Processando..." : "Baixar e Converter";
}

function clearDownloads() {
  Object.values(pollers).forEach((timer) => clearInterval(timer));
  pollers = Object.create(null);
  cards = Object.create(null);
  store = {};
  saveStore();
  downloadsRoot.innerHTML = "";
  syncButtonState();
}

function setStoreJob(job) {
  if (!job || !job.id) return;
  const prev = store[job.id] || {};
  store[job.id] = {
    ...prev,
    ...job,
    startedAt: prev.startedAt || job.startedAt || Date.now(),
    updatedAt: Date.now()
  };
  saveStore();
  syncButtonState();
}

function getCard(jobId) {
  if (cards[jobId]) return cards[jobId];

  const container = document.createElement("article");
  container.className = "download-item";
  container.dataset.jobId = jobId;
  container.innerHTML = `
    <div class="thumb">
      <img alt="">
    </div>
    <div class="download-content">
      <div class="badge">H264</div>
      <div class="video-title">Preparando download...</div>
      <div class="status-text"></div>
      <div class="progress-wrap"><div class="progress-bar"></div></div>
      <div class="download-actions"></div>
    </div>
  `;

  downloadsRoot.prepend(container);
  cards[jobId] = container;
  return container;
}

function humanDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "--";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function fpsText(fps) {
  if (!fps || !Number.isFinite(fps)) return "--";
  const rounded = Math.round(fps * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function renderCard(job) {
  const el = getCard(job.id);
  const img = el.querySelector("img");
  const titleEl = el.querySelector(".video-title");
  const statusEl = el.querySelector(".status-text");
  const bar = el.querySelector(".progress-bar");
  const actions = el.querySelector(".download-actions");

  if (job.thumbnail) img.src = job.thumbnail;
  if (job.title) titleEl.textContent = job.title;

  const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));

  if (job.stage === "starting") {
    statusEl.innerHTML = `Preparando download...<br>${job.speed || "Conectando..."} • ETA ${job.eta || "--"}`;
    bar.style.width = "0%";
    actions.innerHTML = "";
  }

  if (job.stage === "downloading") {
    statusEl.innerHTML = `Baixando... ${progress}%<br>${job.speed || "--"} • ETA ${job.eta || "--"}`;
    bar.style.width = `${progress}%`;
    actions.innerHTML = "";
  }

  if (job.stage === "processing") {
    statusEl.innerHTML = `Mesclando formatos...<br>Finalizando o MP4`;
    bar.style.width = "100%";
    actions.innerHTML = "";
  }

  if (job.stage === "finished") {
    statusEl.innerHTML = `<span class="done">Conversão finalizada com sucesso</span>`;
    bar.style.width = "100%";
    actions.innerHTML = `
      <a class="download-btn" href="${job.file || `/api/file/${job.id}`}" download>Baixar MP4</a>
      <button class="report-btn" type="button" data-report-id="${job.id}">Relatório MP4</button>
    `;

    const reportBtn = actions.querySelector(`[data-report-id="${job.id}"]`);
    if (reportBtn) {
      reportBtn.addEventListener("click", () => openReport(job.id));
    }
  }

  if (job.stage === "error") {
    statusEl.innerHTML = `<span class="error">${job.error || job.message || "Erro ao processar vídeo"}</span>`;
    bar.style.width = "0%";
    actions.innerHTML = "";
  }
}

function stopPolling(jobId) {
  if (pollers[jobId]) {
    clearInterval(pollers[jobId]);
    delete pollers[jobId];
  }
}

async function pollJob(jobId) {
  try {
    const res = await fetch(`/api/status/${encodeURIComponent(jobId)}`, { cache: "no-store" });
    if (!res.ok) {
      return;
    }

    const data = await res.json();
    const merged = { ...(store[jobId] || {}), ...data };

    setStoreJob(merged);
    renderCard(merged);

    if (["finished", "error"].includes(merged.stage)) {
      stopPolling(jobId);
    }
  } catch (err) {
    console.error(err);
  }
}

function startPolling(jobId) {
  stopPolling(jobId);
  pollJob(jobId);
  pollers[jobId] = setInterval(() => pollJob(jobId), 1000);
}

function uuidLike() {
  if (window.crypto?.randomUUID) return crypto.randomUUID();
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function startDownload() {
  const active = activeJobsExist();
  if (active) return;

  const url = urlInput.value.trim();
  const quality = qualityInput.value;

  if (!url) {
    alert("Cole um link");
    return;
  }

  const clientId = uuidLike();
  const initialJob = {
    id: clientId,
    title: "Preparando download...",
    thumbnail: "",
    stage: "starting",
    status: "Preparando download...",
    progress: 0,
    speed: "Conectando...",
    eta: "--",
    file: "",
    done: false,
    error: "",
    report: null,
    startedAt: Date.now()
  };

  setStoreJob(initialJob);
  renderCard(initialJob);
  startPolling(clientId);
  syncButtonState();

  try {
    const res = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, quality, clientId })
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      const job = { ...initialJob, stage: "error", error: data.error || "Erro ao iniciar download" };
      setStoreJob(job);
      renderCard(job);
      stopPolling(clientId);
      return;
    }

    const jobId = data.id || clientId;
    if (jobId !== clientId) {
      const current = store[clientId];
      if (current) {
        delete store[clientId];
        current.id = jobId;
        setStoreJob(current);
        renderCard(current);
        cards[jobId] = cards[clientId];
        delete cards[clientId];
        stopPolling(clientId);
        startPolling(jobId);
      }
    }
  } catch (err) {
    console.error(err);
    const job = { ...initialJob, stage: "error", error: "Erro ao iniciar download" };
    setStoreJob(job);
    renderCard(job);
    stopPolling(clientId);
  }
}

function formatReport(report) {
  const checks = report.checks || {};
  const container = report.container || {};
  const file = report.file || {};
  const video = report.video || {};
  const audio = report.audio || {};

  const chip = (label, ok) => `<span class="report-chip ${ok ? "ok" : ""}">${label}</span>`;

  return `
    <div class="report-summary">
      <div class="report-badges">
        ${chip("MP4", checks.mp4)}
        ${chip(video.codec_name ? video.codec_name.toUpperCase() : "H264", checks.h264)}
        ${chip(audio.codec_name ? audio.codec_name.toUpperCase() : "AAC", checks.aac)}
      </div>

      <div class="report-grid">
        <div class="report-box">
          <h4>Arquivo</h4>
          <div class="report-kv">
            <div class="report-row"><span>Container</span><span>${container.format_name || "--"} (${container.format_long_name || "--"})</span></div>
            <div class="report-row"><span>Tamanho</span><span>${file.size_readable || "--"}</span></div>
            <div class="report-row"><span>Duração</span><span>${humanDuration(file.duration_seconds || 0)}</span></div>
            <div class="report-row"><span>Bitrate total</span><span>${file.bitrate ? `${Math.round(file.bitrate / 1000)} kb/s` : "--"}</span></div>
          </div>
        </div>

        <div class="report-box">
          <h4>Vídeo</h4>
          <div class="report-kv">
            <div class="report-row"><span>Codec</span><span>${video.codec_name || "--"} (${video.codec_long_name || "--"})</span></div>
            <div class="report-row"><span>Resolução</span><span>${video.width && video.height ? `${video.width} × ${video.height}` : "--"}</span></div>
            <div class="report-row"><span>FPS</span><span>${fpsText(video.fps || 0)}</span></div>
            <div class="report-row"><span>Profile</span><span>${video.profile || "--"}</span></div>
            <div class="report-row"><span>Pixel format</span><span>${video.pix_fmt || "--"}</span></div>
          </div>
        </div>

        <div class="report-box">
          <h4>Áudio</h4>
          <div class="report-kv">
            <div class="report-row"><span>Codec</span><span>${audio.codec_name || "--"} (${audio.codec_long_name || "--"})</span></div>
            <div class="report-row"><span>Sample rate</span><span>${audio.sample_rate ? `${audio.sample_rate} Hz` : "--"}</span></div>
            <div class="report-row"><span>Canais</span><span>${audio.channels || "--"}</span></div>
            <div class="report-row"><span>Layout</span><span>${audio.channel_layout || "--"}</span></div>
            <div class="report-row"><span>Bitrate</span><span>${audio.bitrate ? `${Math.round(audio.bitrate / 1000)} kb/s` : "--"}</span></div>
          </div>
        </div>

        <div class="report-box">
          <h4>Compatibilidade</h4>
          <div class="report-kv">
            <div class="report-row"><span>H264</span><span>${checks.h264 ? "Sim" : "Não"}</span></div>
            <div class="report-row"><span>AAC</span><span>${checks.aac ? "Sim" : "Não"}</span></div>
            <div class="report-row"><span>MP4</span><span>${checks.mp4 ? "Sim" : "Não"}</span></div>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function openReport(jobId) {
  reportModal.hidden = false;
  reportSubtitle.textContent = `Job ${jobId}`;
  reportBody.innerHTML = `<div class="report-loading">Carregando relatório...</div>`;

  try {
    const res = await fetch(`/api/report/${encodeURIComponent(jobId)}`, { cache: "no-store" });
    const data = await res.json();

    if (!res.ok || data.error) {
      reportBody.innerHTML = `<div class="report-loading">${data.error || "Não foi possível gerar o relatório."}</div>`;
      return;
    }

    reportBody.innerHTML = formatReport(data);
  } catch (err) {
    reportBody.innerHTML = `<div class="report-loading">${err.message || "Não foi possível gerar o relatório."}</div>`;
  }
}

function closeReport() {
  reportModal.hidden = true;
}

function bootstrap() {
  downloadsRoot.innerHTML = "";
  const jobs = Object.values(store).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

  for (const job of jobs) {
    renderCard(job);
    if (!["finished", "error"].includes(job.stage)) {
      startPolling(job.id);
    }
  }

  syncButtonState();
}

startBtn.addEventListener("click", startDownload);
clearBtn.addEventListener("click", clearDownloads);

reportModal.addEventListener("click", (event) => {
  if (event.target.matches("[data-close-report]")) {
    closeReport();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !reportModal.hidden) {
    closeReport();
  }
});

bootstrap();
