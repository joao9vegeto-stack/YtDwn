const STORAGE_KEY = "ytdown_jobs_v9";

const downloadsRoot = document.getElementById("downloads");
const startBtn = document.getElementById("startBtn");
const clearBtn = document.getElementById("clearBtn");
const urlInput = document.getElementById("url");
const qualitySelect = document.getElementById("quality");

const reportModal = document.getElementById("reportModal");
const reportContent = document.getElementById("reportContent");
const closeReportBtn = document.getElementById("closeReportBtn");

let store = loadStore();
const cards = {};
const polling = {};
const mergeTimers = {};
const uiState = {};

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
  } catch (err) {
    console.error(err);
  }
}

function genId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function activeJobCount() {
  return Object.values(store).filter((job) => !["finished", "error"].includes(job.stage)).length;
}

function refreshButtonState() {
  const active = activeJobCount() > 0;
  startBtn.disabled = active;
  startBtn.textContent = active ? "Processando..." : "Baixar e Converter";
}

function clearDownloads() {
  for (const timer of Object.values(polling)) clearInterval(timer);
  for (const timer of Object.values(mergeTimers)) clearInterval(timer);

  store = {};
  Object.keys(cards).forEach((key) => delete cards[key]);
  Object.keys(polling).forEach((key) => delete polling[key]);
  Object.keys(mergeTimers).forEach((key) => delete mergeTimers[key]);
  Object.keys(uiState).forEach((key) => delete uiState[key]);

  saveStore();
  downloadsRoot.innerHTML = "";
  refreshButtonState();
}

function persist(job) {
  if (!job || !job.id) return;

  const prev = store[job.id] || {};
  store[job.id] = {
    ...prev,
    ...job,
    startedAt: prev.startedAt || job.startedAt || Date.now(),
    updatedAt: Date.now(),
  };

  saveStore();
  refreshButtonState();
}

function getCard(jobId) {
  if (cards[jobId]) return cards[jobId];

  const el = document.createElement("article");
  el.className = "download-item";
  el.dataset.jobId = jobId;
  el.innerHTML = `
    <div class="thumb">
      <img alt="">
    </div>
    <div class="download-content">
      <div class="badge">H264</div>
      <div class="video-title">Preparando download...</div>
      <div class="status-text"></div>
      <div class="progress-wrap">
        <div class="progress-bar"></div>
      </div>
      <div class="download-actions"></div>
    </div>
  `;

  downloadsRoot.prepend(el);

  cards[jobId] = {
    element: el,
    img: el.querySelector("img"),
    title: el.querySelector(".video-title"),
    status: el.querySelector(".status-text"),
    bar: el.querySelector(".progress-bar"),
    actions: el.querySelector(".download-actions"),
  };

  return cards[jobId];
}

function stopMergeAnimation(jobId) {
  if (mergeTimers[jobId]) {
    clearInterval(mergeTimers[jobId]);
    delete mergeTimers[jobId];
  }
  delete uiState[jobId];
}

function startMergeAnimation(jobId) {
  if (mergeTimers[jobId]) return;

  uiState[jobId] = uiState[jobId] || {};
  const timer = setInterval(() => {
    const job = store[jobId];
    if (!job || job.stage !== "processing") {
      stopMergeAnimation(jobId);
      return;
    }

    const current = Number.isFinite(uiState[jobId].visualProgress)
      ? uiState[jobId].visualProgress
      : Math.max(job.progress || 0, 95);

    const next = Math.min(99, current + Math.max(0.25, (99 - current) * 0.12));
    uiState[jobId].visualProgress = next;
    renderJob({ ...job, visualProgress: next }, false);
  }, 300);

  mergeTimers[jobId] = timer;
}

function renderJob(job, shouldPersist = true) {
  if (!job || !job.id) return;

  const card = getCard(job.id);

  if (job.thumbnail) card.img.src = job.thumbnail;
  if (job.title) card.title.textContent = job.title;

  const progress =
    Number.isFinite(job.visualProgress)
      ? job.visualProgress
      : Number.isFinite(job.progress)
        ? job.progress
        : 0;

  if (job.stage === "starting") {
    card.status.innerHTML = `Preparando download...<br>${job.speed || "Conectando..."} • ETA ${job.eta || "--"}`;
    card.bar.style.width = "0%";
    card.actions.innerHTML = "";
  }

  if (job.stage === "downloading") {
    card.status.innerHTML = `Baixando... ${Math.floor(progress)}%<br>${job.speed || "--"} • ETA ${job.eta || "--"}`;
    card.bar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    card.actions.innerHTML = "";
  }

  if (job.stage === "processing") {
    card.status.innerHTML = `Mesclando formatos...<br>${Math.floor(progress)}% concluído • ETA ${job.eta || "--"}`;
    card.bar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    card.actions.innerHTML = "";
  }

  if (job.stage === "finished" || job.done) {
    stopMergeAnimation(job.id);
    card.status.innerHTML = `<span class="done">Concluído</span>`;
    card.bar.style.width = "100%";

    const downloadUrl = job.file || `/api/file/${job.id}`;
    const reportUrl = job.report || `/api/report/${job.id}`;

    card.actions.innerHTML = `
      <a class="download-btn" href="${downloadUrl}" download>Baixar MP4</a>
      <button type="button" class="secondary-btn" data-report="${reportUrl}">Relatório do MP4</button>
    `;

    const reportBtn = card.actions.querySelector("[data-report]");
    reportBtn.addEventListener("click", () => openReport(job.id));
  }

  if (job.stage === "error" || job.error) {
    stopMergeAnimation(job.id);
    card.status.innerHTML = `<span class="error">${job.error || "Erro ao processar vídeo"}</span>`;
    card.actions.innerHTML = "";
  }

  if (shouldPersist) {
    persist(job);
  }
}

function stopPolling(jobId) {
  if (polling[jobId]) {
    clearInterval(polling[jobId]);
    delete polling[jobId];
  }
}

async function pollJob(jobId) {
  try {
    const res = await fetch(`/api/status/${encodeURIComponent(jobId)}`, {
      cache: "no-store",
    });

    if (!res.ok) {
      const job = store[jobId];
      if (job && !["finished", "error"].includes(job.stage)) {
        renderJob({
          ...job,
          stage: "error",
          error: "Job não encontrado",
        });
      }
      stopPolling(jobId);
      return;
    }

    const data = await res.json();
    const merged = {
      ...(store[jobId] || {}),
      ...data,
    };

    if (merged.stage === "processing") {
      startMergeAnimation(jobId);
      if (!uiState[jobId] || !Number.isFinite(uiState[jobId].visualProgress)) {
        uiState[jobId] = uiState[jobId] || {};
        uiState[jobId].visualProgress = Math.max(merged.progress || 0, 95);
      }
    } else {
      stopMergeAnimation(jobId);
    }

    renderJob(merged);

    if (merged.stage === "finished" || merged.done || merged.error) {
      stopPolling(jobId);
    }
  } catch (err) {
    console.error(err);
  }
}

function startPolling(jobId) {
  if (polling[jobId]) return;
  pollJob(jobId);
  polling[jobId] = setInterval(() => pollJob(jobId), 1000);
}

function migrateJobId(oldId, newId) {
  if (oldId === newId) return;

  const oldJob = store[oldId];
  if (!oldJob) return;

  store[newId] = { ...oldJob, id: newId };
  delete store[oldId];

  if (cards[oldId]) {
    cards[newId] = cards[oldId];
    delete cards[oldId];
    cards[newId].element.dataset.jobId = newId;
  }

  if (polling[oldId]) {
    polling[newId] = polling[oldId];
    delete polling[oldId];
  }

  if (mergeTimers[oldId]) {
    mergeTimers[newId] = mergeTimers[oldId];
    delete mergeTimers[oldId];
  }

  if (uiState[oldId]) {
    uiState[newId] = uiState[oldId];
    delete uiState[oldId];
  }

  saveStore();
}

async function startDownload() {
  if (activeJobCount() > 0) return;

  const url = urlInput.value.trim();
  const quality = qualitySelect.value;

  if (!url) {
    alert("Cole um link");
    return;
  }

  const clientId = genId();

  const optimisticJob = {
    id: clientId,
    title: "Preparando download...",
    thumbnail: "",
    stage: "starting",
    status: "Preparando download...",
    progress: 0,
    speed: "Conectando...",
    eta: "--",
    done: false,
    file: "",
    report: "",
    error: "",
    startedAt: Date.now(),
  };

  renderJob(optimisticJob);
  startPolling(clientId);

  console.log("POST /api/download", { url, quality, clientId });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch("/api/download", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        quality,
        clientId,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.error) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    const returnedId = data.jobId || clientId;

    if (returnedId !== clientId) {
      migrateJobId(clientId, returnedId);
    }

    persist({ ...optimisticJob, id: returnedId });
    startPolling(returnedId);
  } catch (err) {
    clearTimeout(timeout);
    console.error(err);

    renderJob({
      ...optimisticJob,
      stage: "error",
      error:
        err.name === "AbortError"
          ? "Tempo limite na requisição"
          : "Erro ao iniciar download",
    });
    stopPolling(clientId);
  }
}

function formatRow(label, value) {
  return `
    <div class="report-item">
      <span class="report-label">${label}</span>
      <div class="report-value">${value ?? "--"}</div>
    </div>
  `;
}

async function openReport(jobId) {
  reportModal.classList.remove("hidden");
  reportModal.setAttribute("aria-hidden", "false");
  reportContent.innerHTML = `<div class="report-raw">Carregando relatório...</div>`;

  try {
    const res = await fetch(`/api/report/${encodeURIComponent(jobId)}`, {
      cache: "no-store",
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      reportContent.innerHTML = `<div class="report-raw">Erro: ${data.error || "falha ao gerar relatório"}</div>`;
      return;
    }

    const compatibility = data.compatibility || {};
    const video = data.video || {};
    const audio = data.audio || {};

    const summaryLine = `
      <div class="report-summary">
        <div class="report-pill">${compatibility.afterEffectsFriendly ? "Compatível com After Effects" : "Requer atenção"}</div>
      </div>
    `;

    const grid = `
      <div class="report-grid">
        ${formatRow("Arquivo", data.fileName)}
        ${formatRow("Tamanho", data.fileSize)}
        ${formatRow("Container", `${data.container} (${data.containerLong})`)}
        ${formatRow("Duração", data.duration)}
        ${formatRow("Bitrate total", data.bitrate)}
        ${formatRow("Vídeo codec", `${video.codec} (${video.codecLong})`)}
        ${formatRow("Perfil", video.profile)}
        ${formatRow("Resolução", video.resolution)}
        ${formatRow("FPS", video.fpsText)}
        ${formatRow("Pixel format", video.pixFmt)}
        ${formatRow("Áudio codec", `${audio.codec} (${audio.codecLong})`)}
        ${formatRow("Sample rate", audio.sampleRate)}
        ${formatRow("Canais", audio.channels != null ? String(audio.channels) : "--")}
        ${formatRow("Layout", audio.channelLayout)}
        ${formatRow("Compatibilidade AE", compatibility.afterEffectsFriendly ? "Sim" : "Não garantido")}
        ${formatRow("H.264", compatibility.h264 ? "Sim" : "Não")}
        ${formatRow("AAC", compatibility.aac ? "Sim" : "Não")}
      </div>
    `;

    const rawJson = `
${JSON.stringify(data, null, 2)}
`;

    reportContent.innerHTML = `
      ${summaryLine}
      ${grid}
      <div class="report-raw">${rawJson.replace(/</g, "&lt;")}</div>
    `;
  } catch (err) {
    console.error(err);
    reportContent.innerHTML = `<div class="report-raw">Falha ao carregar relatório.</div>`;
  }
}

function closeReport() {
  reportModal.classList.add("hidden");
  reportModal.setAttribute("aria-hidden", "true");
}

function bootstrap() {
  downloadsRoot.innerHTML = "";
  const jobs = Object.values(store).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

  for (const job of jobs) {
    renderJob(job, false);
    if (!["finished", "error"].includes(job.stage)) {
      startPolling(job.id);
    }
  }

  refreshButtonState();
}

startBtn.addEventListener("click", startDownload);
clearBtn.addEventListener("click", clearDownloads);
closeReportBtn.addEventListener("click", closeReport);

reportModal.addEventListener("click", (event) => {
  if (event.target && event.target.dataset && event.target.dataset.close) {
    closeReport();
  }
});

bootstrap();
