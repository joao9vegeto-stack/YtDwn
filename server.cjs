const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const http = require("http");
const compression = require("compression");
const { Server } = require("socket.io");
const YTDlpWrap = require("yt-dlp-wrap").default;

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
const ytDlp = new YTDlpWrap();

const downloadsDir = path.join(__dirname, "downloads");
const jobs = Object.create(null);
let busy = false;

function ensureDownloadsDir() {
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }
}

ensureDownloadsDir();

app.use(
  compression({
    filter: (req, res) => {
      if (req.path.startsWith("/downloads/")) return false;
      return compression.filter(req, res);
    }
  })
);

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));

app.use(
  "/downloads",
  express.static(downloadsDir, {
    fallthrough: false,
    maxAge: 0,
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-store");
    }
  })
);

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/health", (req, res) => {
  res.json({ status: "online" });
});

app.get("/download/:file", (req, res) => {
  const filePath = path.join(downloadsDir, req.params.file);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Arquivo não encontrado");
  }

  return res.download(filePath);
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeRemove(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error(err);
  }
}

function cleanJobFiles(id) {
  try {
    const files = fs.readdirSync(downloadsDir);
    for (const file of files) {
      if (file.startsWith(id)) {
        safeRemove(path.join(downloadsDir, file));
      }
    }
  } catch (err) {
    console.error(err);
  }
}

function parseEtaToSeconds(eta) {
  if (!eta || eta === "--" || eta === "Unknown") return null;

  const parts = String(eta)
    .trim()
    .split(":")
    .map((part) => Number(part));

  if (parts.some((n) => Number.isNaN(n))) return null;

  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];

  return null;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--";

  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function parseProgressLine(text) {
  const match = text.match(
    /(\d+(?:\.\d+)?)%\s+of.*?at\s+([^\s]+).*?ETA\s+([0-9:]+|Unknown)/
  );

  if (!match) return null;

  return {
    percent: Number.parseFloat(match[1]),
    speed: match[2],
    eta: match[3]
  };
}

function publicJob(job) {
  return {
    id: job.id,
    url: job.url,
    quality: job.quality,
    title: job.title,
    thumbnail: job.thumbnail,
    stage: job.stage,
    percent: Number.isFinite(job.percent) ? job.percent : 0,
    speed: job.speed || "--",
    eta: job.eta || "--",
    download: job.download || "",
    error: job.error || "",
    startedAt: job.startedAt || Date.now(),
    updatedAt: job.updatedAt || Date.now()
  };
}

function emitJob(job) {
  job.updatedAt = Date.now();
  io.emit("progress", publicJob(job));
}

function setJob(id, patch) {
  const job = jobs[id];
  if (!job) return null;
  Object.assign(job, patch);
  emitJob(job);
  return job;
}

async function waitForMergedFile(id, timeout = 60000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const exact = path.join(downloadsDir, `${id}.source.mp4`);
    if (fs.existsSync(exact)) return exact;

    const candidates = fs
      .readdirSync(downloadsDir)
      .filter((name) => name.startsWith(`${id}.source`) && name.endsWith(".mp4"))
      .sort((a, b) => a.length - b.length);

    if (candidates.length > 0) {
      const candidatePath = path.join(downloadsDir, candidates[0]);
      if (fs.existsSync(candidatePath)) return candidatePath;
    }

    const elapsed = timeout - (deadline - Date.now());
    const percent = Math.min(99, Math.max(0, Math.round((elapsed / timeout) * 100)));
    const etaSeconds = Math.max(0, (deadline - Date.now()) / 1000);

    setJob(id, {
      stage: "merging",
      percent,
      speed: "Mesclando formatos...",
      eta: formatEta(etaSeconds)
    });

    await sleep(250);
  }

  throw new Error("MP4 mesclado não encontrado");
}

async function processDownload(job) {
  const { id, url, quality } = job;

  try {
    setJob(id, {
      stage: "starting",
      percent: 0,
      speed: "Conectando...",
      eta: "--",
      error: ""
    });

    const info = await ytDlp.getVideoInfo(url);

    const title = info.title || "Vídeo";
    const thumbnail =
      info.thumbnail ||
      (info.thumbnails?.length
        ? info.thumbnails[info.thumbnails.length - 1].url
        : "");

    setJob(id, { title, thumbnail });

    const safeQuality = String(quality || "1080").replace(/\D/g, "") || "1080";
    const outputTemplate = path.join(downloadsDir, `${id}.source.%(ext)s`);
    const finalPath = path.join(downloadsDir, `${id}.mp4`);

    cleanJobFiles(id);
    safeRemove(finalPath);

    const yt = ytDlp.exec([
      url,
      "--no-playlist",
      "-f",
      `bestvideo[height<=${safeQuality}][vcodec*=avc1]+bestaudio[acodec*=mp4a]/bestvideo[height<=${safeQuality}]+bestaudio/best`,
      "--merge-output-format",
      "mp4",
      "--newline",
      "-o",
      outputTemplate
    ]);

    let downloadEtaEma = null;
    let lastPercent = 0;

    yt.on("ytDlpEvent", (_type, data) => {
      const text = String(data || "");
      console.log(text);

      const parsed = parseProgressLine(text);

      if (parsed) {
        const etaSeconds = parseEtaToSeconds(parsed.eta);

        if (etaSeconds !== null) {
          downloadEtaEma =
            downloadEtaEma === null
              ? etaSeconds
              : downloadEtaEma * 0.7 + etaSeconds * 0.3;
        }

        lastPercent = Math.max(lastPercent, Math.min(100, parsed.percent));

        setJob(id, {
          stage: "downloading",
          percent: lastPercent,
          speed: parsed.speed,
          eta: downloadEtaEma !== null ? formatEta(downloadEtaEma) : parsed.eta
        });
      }

      if (text.includes("Merging formats into")) {
        setJob(id, {
          stage: "merging",
          percent: 0,
          speed: "Mesclando formatos...",
          eta: "0:05"
        });
      }
    });

    await yt.promise;

    const mergedPath = await waitForMergedFile(id);

    safeRemove(finalPath);
    fs.renameSync(mergedPath, finalPath);

    setJob(id, {
      stage: "finished",
      percent: 100,
      speed: "--",
      eta: "--",
      download: `/download/${id}.mp4`
    });

    return publicJob(jobs[id]);
  } catch (err) {
    console.error(err);

    setJob(id, {
      stage: "error",
      error: err.message || "Erro ao processar vídeo",
      speed: "--",
      eta: "--"
    });

    throw err;
  }
}

app.get("/api/status/:id", (req, res) => {
  const { id } = req.params;
  const job = jobs[id];
  const finalPath = path.join(downloadsDir, `${id}.mp4`);

  if (job) {
    const payload = publicJob(job);
    if (payload.stage === "finished" && fs.existsSync(finalPath)) {
      payload.download = `/download/${id}.mp4`;
    }
    return res.json(payload);
  }

  if (fs.existsSync(finalPath)) {
    return res.json({
      id,
      stage: "finished",
      percent: 100,
      download: `/download/${id}.mp4`
    });
  }

  const sourceFiles = fs
    .readdirSync(downloadsDir)
    .filter((name) => name.startsWith(`${id}.source`));

  if (sourceFiles.length > 0) {
    return res.json({
      id,
      stage: "merging",
      percent: 0,
      speed: "Mesclando formatos...",
      eta: "--"
    });
  }

  return res.status(404).json({ error: "Job não encontrado" });
});

app.post("/api/download", async (req, res) => {
  if (busy) {
    return res.status(429).json({ error: "Servidor ocupado" });
  }

  const { url, quality, clientId } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: "URL inválida" });
  }

  const id = String(clientId || `job_${Date.now()}`);

  if (jobs[id]) {
    return res.status(409).json({ error: "Já existe um job com esse id" });
  }

  busy = true;

  jobs[id] = {
    id,
    url,
    quality: String(quality || "1080"),
    title: "Preparando download...",
    thumbnail: "",
    stage: "starting",
    percent: 0,
    speed: "Conectando...",
    eta: "--",
    download: "",
    error: "",
    startedAt: Date.now(),
    updatedAt: Date.now()
  };

  emitJob(jobs[id]);

  res.status(202).json({
    success: true,
    id
  });

  processDownload(jobs[id])
    .catch(() => {})
    .finally(() => {
      busy = false;
    });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
