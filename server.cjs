const express = require("express");
const cors = require("cors");
const compression = require("compression");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join("/tmp", "ytdwn");

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

const jobs = Object.create(null);
let activeJobId = null;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(
  compression({
    filter: (req, res) => {
      if (req.path.startsWith("/api/file/") || req.path.startsWith("/downloads/")) {
        return false;
      }
      return compression.filter(req, res);
    }
  })
);

app.use(express.static(path.join(__dirname, "public")));
app.use("/downloads", express.static(DOWNLOAD_DIR, { fallthrough: false }));

function now() {
  return Date.now();
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return "--";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function parseFraction(value) {
  if (!value || value === "0/0") return null;
  const parts = String(value).split("/").map(Number);
  if (parts.length !== 2 || parts.some((n) => Number.isNaN(n))) return null;
  if (parts[1] === 0) return null;
  return parts[0] / parts[1];
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

function removeJobFiles(jobId) {
  try {
    const files = fs.readdirSync(DOWNLOAD_DIR);
    for (const file of files) {
      if (file.startsWith(jobId)) {
        safeRemove(path.join(DOWNLOAD_DIR, file));
      }
    }
  } catch (err) {
    console.error(err);
  }
}

function waitForFile(filePath, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = now();
    const timer = setInterval(() => {
      if (fs.existsSync(filePath)) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error("Arquivo final não encontrado"));
      }
    }, 200);
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || `${command} failed with code ${code}`));
      }
    });
  });
}

async function getVideoInfo(url) {
  const { stdout } = await runCommand("yt-dlp", [
    "-J",
    "--no-playlist",
    url
  ]);

  const info = JSON.parse(stdout);
  const thumbnail = info.thumbnail || (Array.isArray(info.thumbnails) && info.thumbnails.length
    ? info.thumbnails[info.thumbnails.length - 1].url
    : "");

  return {
    title: info.title || "Vídeo",
    thumbnail,
    duration: Number(info.duration || 0) || 0,
    webpage_url: info.webpage_url || url
  };
}

async function probeMedia(filePath) {
  const { stdout } = await runCommand("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath
  ]);

  const json = JSON.parse(stdout);
  const format = json.format || {};
  const streams = Array.isArray(json.streams) ? json.streams : [];
  const video = streams.find((s) => s.codec_type === "video") || null;
  const audio = streams.find((s) => s.codec_type === "audio") || null;
  const fps = video ? parseFraction(video.avg_frame_rate || video.r_frame_rate) : null;

  const report = {
    container: {
      format_name: format.format_name || "--",
      format_long_name: format.format_long_name || "--"
    },
    file: {
      size_bytes: Number(format.size || 0) || 0,
      size_readable: humanBytes(Number(format.size || 0) || 0),
      duration_seconds: Number(format.duration || 0) || 0,
      duration_readable: Number(format.duration || 0) || 0,
      bitrate: Number(format.bit_rate || 0) || 0
    },
    video: video ? {
      codec_name: video.codec_name || "--",
      codec_long_name: video.codec_long_name || "--",
      profile: video.profile || "--",
      width: Number(video.width || 0) || 0,
      height: Number(video.height || 0) || 0,
      pix_fmt: video.pix_fmt || "--",
      fps: fps || 0,
      bitrate: Number(video.bit_rate || 0) || 0
    } : null,
    audio: audio ? {
      codec_name: audio.codec_name || "--",
      codec_long_name: audio.codec_long_name || "--",
      sample_rate: Number(audio.sample_rate || 0) || 0,
      channels: Number(audio.channels || 0) || 0,
      channel_layout: audio.channel_layout || "--",
      bitrate: Number(audio.bit_rate || 0) || 0
    } : null,
    checks: {
      mp4: String(format.format_name || "").includes("mp4"),
      h264: !!video && ["h264", "avc1"].includes(String(video.codec_name || "").toLowerCase()),
      aac: !!audio && String(audio.codec_name || "").toLowerCase() === "aac"
    }
  };

  return report;
}

function publicJob(job) {
  return {
    id: job.id,
    title: job.title,
    thumbnail: job.thumbnail,
    stage: job.stage,
    status: job.status,
    progress: job.progress,
    speed: job.speed,
    eta: job.eta,
    file: job.file,
    done: job.done,
    error: job.error,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt
  };
}

function setJob(jobId, patch) {
  const job = jobs[jobId];
  if (!job) return;
  Object.assign(job, patch, { updatedAt: now() });
}

function parsePercent(text) {
  const match = String(text).match(/(\d+(?:\.\d+)?)%\s+of/);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

function parseSpeed(text) {
  const s = String(text);
  const m1 = s.match(/\bat\s+([0-9.]+\w+\/s)\b/i);
  if (m1) return m1[1];
  const m2 = s.match(/\bDL:([0-9.]+\w+)\b/i);
  if (m2) return `${m2[1]}/s`;
  const m3 = s.match(/\b([0-9.]+(?:KiB|MiB|GiB)\/s)\b/i);
  if (m3) return m3[1];
  return null;
}

function parseEta(text) {
  const s = String(text);
  const m = s.match(/\bETA\s*:?(\s*[0-9:]+|\s*[0-9]+s|\s*Unknown)\b/i);
  if (m) return m[1].trim();
  return null;
}

function cleanupOldFiles() {
  const cutoff = now() - 1000 * 60 * 60;
  try {
    for (const file of fs.readdirSync(DOWNLOAD_DIR)) {
      const filePath = path.join(DOWNLOAD_DIR, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        safeRemove(filePath);
      }
    }
  } catch (err) {
    console.error(err);
  }
}

setInterval(cleanupOldFiles, 1000 * 60 * 10);

async function processDownload(jobId, url, quality) {
  const job = jobs[jobId];
  if (!job) return;

  try {
    setJob(jobId, {
      stage: "starting",
      status: "Preparando download...",
      progress: 0,
      speed: "Conectando...",
      eta: "--"
    });

    const info = await getVideoInfo(url);
    setJob(jobId, {
      title: info.title,
      thumbnail: info.thumbnail
    });

    const q = String(quality || "1080").replace(/\D/g, "") || "1080";
    const outputTemplate = path.join(DOWNLOAD_DIR, `${jobId}.%(ext)s`);
    const finalPath = path.join(DOWNLOAD_DIR, `${jobId}.mp4`);

    removeJobFiles(jobId);
    safeRemove(finalPath);

    const args = [
      "--no-playlist",
      "--newline",
      "--progress",
      "--downloader",
      "aria2c",
      "--downloader-args",
      "aria2c:-x 16 -s 16 -k 1M",
      "-f",
      `bestvideo[height<=${q}][vcodec*=avc1]+bestaudio[acodec*=mp4a]/bestvideo[height<=${q}]+bestaudio/best`,
      "--merge-output-format",
      "mp4",
      "-o",
      outputTemplate,
      url
    ];

    const yt = spawn("yt-dlp", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let buffer = "";
    let mergeSeen = false;
    let lastPercent = 0;
    let lastEta = "--";
    let lastSpeed = "--";

    const handleLine = (line) => {
      const text = String(line || "").trim();
      if (!text) return;
      console.log(text);

      const percent = parsePercent(text);
      const speed = parseSpeed(text);
      const eta = parseEta(text);

      if (typeof percent === "number" && !mergeSeen) {
        lastPercent = Math.max(lastPercent, Math.min(100, percent));
        if (speed) lastSpeed = speed;
        if (eta) lastEta = eta;
        setJob(jobId, {
          stage: "downloading",
          status: "Baixando...",
          progress: lastPercent,
          speed: lastSpeed,
          eta: lastEta
        });
      }

      if (text.includes("Merging formats into") && !mergeSeen) {
        mergeSeen = true;
        setJob(jobId, {
          stage: "processing",
          status: "Mesclando formatos... Finalizando o MP4",
          progress: 100,
          speed: "--",
          eta: "--"
        });
      }
    };

    const consume = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) handleLine(line);
    };

    yt.stdout.on("data", consume);
    yt.stderr.on("data", consume);

    const closePromise = new Promise((resolve, reject) => {
      yt.on("error", reject);
      yt.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`yt-dlp saiu com código ${code}`));
      });
    });

    await closePromise;

    await waitForFile(finalPath, 15000);

    const report = await probeMedia(finalPath);
    job.report = report;

    setJob(jobId, {
      stage: "finished",
      status: "Concluído",
      progress: 100,
      speed: "--",
      eta: "--",
      done: true,
      file: `/api/file/${jobId}`,
      report
    });
  } catch (err) {
    console.error(err);
    setJob(jobId, {
      stage: "error",
      status: "Erro ao processar vídeo",
      error: err.message || "Erro ao processar vídeo",
      done: false
    });
  } finally {
    if (activeJobId === jobId) {
      activeJobId = null;
    }
  }
}

app.post("/api/download", async (req, res) => {
  if (activeJobId) {
    return res.status(429).json({ error: "Servidor ocupado" });
  }

  const { url, quality, clientId } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: "URL inválida" });
  }

  const jobId = String(clientId || `job_${now()}`);

  activeJobId = jobId;
  jobs[jobId] = {
    id: jobId,
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
    startedAt: now(),
    updatedAt: now()
  };

  res.status(202).json({ success: true, id: jobId });
  processDownload(jobId, url, quality);
});

app.get("/api/status/:id", (req, res) => {
  const { id } = req.params;
  const job = jobs[id];
  const filePath = path.join(DOWNLOAD_DIR, `${id}.mp4`);

  if (job) {
    if (job.stage === "finished" && !job.report && fs.existsSync(filePath)) {
      probeMedia(filePath)
        .then((report) => {
          job.report = report;
          job.updatedAt = now();
        })
        .catch(() => {});
    }
    return res.json(publicJob(job));
  }

  if (fs.existsSync(filePath)) {
    return res.json({
      id,
      title: "Vídeo",
      thumbnail: "",
      stage: "finished",
      status: "Concluído",
      progress: 100,
      speed: "--",
      eta: "--",
      file: `/api/file/${id}`,
      done: true,
      error: "",
      startedAt: now(),
      updatedAt: now()
    });
  }

  return res.status(404).json({ error: "Job não encontrado" });
});

app.get("/api/report/:id", async (req, res) => {
  const { id } = req.params;
  const job = jobs[id];
  const filePath = path.join(DOWNLOAD_DIR, `${id}.mp4`);

  if (job?.report) {
    return res.json(job.report);
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Arquivo final não encontrado" });
  }

  try {
    const report = await probeMedia(filePath);
    if (job) job.report = report;
    return res.json(report);
  } catch (err) {
    return res.status(500).json({ error: err.message || "Falha ao gerar relatório" });
  }
});

app.get("/api/file/:id", (req, res) => {
  const { id } = req.params;
  const filePath = path.join(DOWNLOAD_DIR, `${id}.mp4`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Arquivo não encontrado");
  }

  const stat = fs.statSync(filePath);
  res.status(200);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Content-Disposition", `attachment; filename="${id}.mp4"`);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).end("Erro ao ler arquivo");
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
