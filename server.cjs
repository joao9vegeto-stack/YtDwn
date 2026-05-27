const express = require("express");
const cors = require("cors");
const compression = require("compression");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = "/tmp/ytdwn";

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

const jobs = Object.create(null);
let busy = false;

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(
  compression({
    level: 6,
    threshold: 0,
  })
);

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.use(express.static(path.join(__dirname, "public")));

function createJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeUnlink(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error(err);
  }
}

function cleanOldFiles() {
  const now = Date.now();

  try {
    for (const file of fs.readdirSync(DOWNLOAD_DIR)) {
      const filePath = path.join(DOWNLOAD_DIR, file);
      const stat = fs.statSync(filePath);

      if (now - stat.mtimeMs > 1000 * 60 * 30) {
        safeUnlink(filePath);
      }
    }
  } catch (err) {
    console.error(err);
  }
}

setInterval(cleanOldFiles, 1000 * 60 * 5);

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
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
        reject(new Error(stderr || `Command failed with exit code ${code}`));
      }
    });
  });
}

function parseFraction(value) {
  if (!value || typeof value !== "string") return null;
  if (!value.includes("/")) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  const [a, b] = value.split("/").map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return a / b;
}

function humanFileSize(bytes) {
  if (!Number.isFinite(bytes)) return "--";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function humanDuration(seconds) {
  if (!Number.isFinite(seconds)) return "--";
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function makePublicJob(job) {
  return {
    id: job.id,
    title: job.title,
    thumbnail: job.thumbnail,
    stage: job.stage,
    status: job.status,
    progress: job.progress,
    speed: job.speed,
    eta: job.eta,
    done: job.done,
    file: job.file,
    report: job.report,
    error: job.error,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
  };
}

function setJob(jobId, patch) {
  const job = jobs[jobId];
  if (!job) return;
  Object.assign(job, patch);
  job.updatedAt = Date.now();
}

function parseDownloadLine(text) {
  const pct = text.match(/(\d+(?:\.\d+)?)%\s+of/i);
  const speed = text.match(/at\s+([^\s]+)\s+ETA/i);
  const eta = text.match(/ETA\s+([0-9:]+|Unknown|Unknown\ss)/i);

  return {
    percent: pct ? Number.parseFloat(pct[1]) : null,
    speed: speed ? speed[1] : null,
    eta: eta ? eta[1].trim() : null,
  };
}

async function probeFile(filePath) {
  const { stdout } = await runCommand("ffprobe", [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);

  const raw = JSON.parse(stdout || "{}");
  const format = raw.format || {};
  const streams = Array.isArray(raw.streams) ? raw.streams : [];

  const video = streams.find((s) => s.codec_type === "video") || null;
  const audio = streams.find((s) => s.codec_type === "audio") || null;

  const fps = video
    ? parseFraction(video.avg_frame_rate || video.r_frame_rate || "")
    : null;

  const videoCodec = video?.codec_name || "";
  const audioCodec = audio?.codec_name || "";
  const isH264 = /^(h264|avc1)$/i.test(videoCodec) || /h264|avc/i.test(String(videoCodec));
  const isAAC = /^aac$/i.test(audioCodec);

  return {
    fileName: path.basename(filePath),
    fileSizeBytes: fs.statSync(filePath).size,
    fileSize: humanFileSize(fs.statSync(filePath).size),
    container: format.format_name || "--",
    containerLong: format.format_long_name || "--",
    durationSeconds: Number(format.duration || 0) || null,
    duration: humanDuration(Number(format.duration || 0)),
    bitrate: format.bit_rate ? `${Math.round(Number(format.bit_rate) / 1000)} kb/s` : "--",
    video: video
      ? {
          codec: video.codec_name || "--",
          codecLong: video.codec_long_name || "--",
          profile: video.profile || "--",
          width: video.width || null,
          height: video.height || null,
          resolution:
            video.width && video.height ? `${video.width}x${video.height}` : "--",
          fps: fps ? Number(fps.toFixed(3)) : null,
          fpsText: fps ? `${fps.toFixed(3)} fps` : "--",
          pixFmt: video.pix_fmt || "--",
          bitrate: video.bit_rate ? `${Math.round(Number(video.bit_rate) / 1000)} kb/s` : "--",
        }
      : null,
    audio: audio
      ? {
          codec: audio.codec_name || "--",
          codecLong: audio.codec_long_name || "--",
          sampleRate: audio.sample_rate ? `${audio.sample_rate} Hz` : "--",
          channels: audio.channels || null,
          channelLayout: audio.channel_layout || "--",
          bitrate: audio.bit_rate ? `${Math.round(Number(audio.bit_rate) / 1000)} kb/s` : "--",
        }
      : null,
    compatibility: {
      afterEffectsFriendly: Boolean(isH264 && isAAC),
      h264: Boolean(isH264),
      aac: Boolean(isAAC),
      mp4: /mp4|mov|m4a|3gp|3g2|mj2/i.test(String(format.format_name || "")),
    },
  };
}

async function processDownload(jobId, url, quality) {
  const job = jobs[jobId];
  const outputTemplate = path.join(DOWNLOAD_DIR, `${jobId}.%(ext)s`);
  const finalMp4 = path.join(DOWNLOAD_DIR, `${jobId}.mp4`);

  safeUnlink(finalMp4);

  try {
    setJob(jobId, {
      stage: "starting",
      status: "Preparando download...",
      progress: 0,
      speed: "Conectando...",
      eta: "--",
      done: false,
      error: "",
    });

    const ytInfo = await runCommand("yt-dlp", ["-J", "--no-playlist", url]);
    const info = JSON.parse(ytInfo.stdout || "{}");

    const title = info.title || "Vídeo";
    const thumbnail =
      info.thumbnail ||
      (Array.isArray(info.thumbnails) && info.thumbnails.length
        ? info.thumbnails[info.thumbnails.length - 1].url
        : "");

    setJob(jobId, { title, thumbnail });

    const safeQuality = String(quality || "1080").replace(/\D/g, "") || "1080";

    const args = [
  "--no-playlist",
  "--newline",
  "--progress",
  "--cookies",
  "cookies.txt",
  "-f",
  `bv*[ext=mp4][height<=${safeQuality}]+ba[ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/18/best`,
  "--merge-output-format",
  "mp4",
  "-o",
  outputTemplate,
  url,
];

    const yt = spawn("yt-dlp", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const handleOutput = (chunk) => {
      const text = chunk.toString();
      console.log(text);

      if (text.includes("Merging formats into")) {
        setJob(jobId, {
          stage: "processing",
          status: "Mesclando formatos...",
          progress: 99,
          speed: "--",
          eta: "0:05",
        });
      }

      const lines = text.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const parsed = parseDownloadLine(line);
        if (parsed.percent !== null) {
          setJob(jobId, {
            stage: "downloading",
            status: "Baixando...",
            progress: Math.max(0, Math.min(100, parsed.percent)),
            speed: parsed.speed || job.speed || "--",
            eta: parsed.eta || job.eta || "--",
          });
        }
      }
    };

    yt.stdout.on("data", handleOutput);
    yt.stderr.on("data", handleOutput);

    yt.on("error", (err) => {
      console.error(err);
      setJob(jobId, {
        stage: "error",
        status: "Erro",
        error: err.message || "Erro ao processar vídeo",
        done: false,
      });
    });

    yt.on("close", async (code) => {
      try {
        if (code !== 0) {
          setJob(jobId, {
            stage: "error",
            status: "Erro",
            error: `yt-dlp saiu com código ${code}`,
            done: false,
          });
          return;
        }

        if (!fs.existsSync(finalMp4)) {
          setJob(jobId, {
            stage: "error",
            status: "Erro ao finalizar MP4",
            error: "Arquivo final não encontrado",
            done: false,
          });
          return;
        }

        const stat = fs.statSync(finalMp4);
        if (!stat || stat.size < 1024) {
          setJob(jobId, {
            stage: "error",
            status: "Arquivo final inválido",
            error: "MP4 final muito pequeno",
            done: false,
          });
          return;
        }

        setJob(jobId, {
          stage: "finished",
          status: "Concluído",
          progress: 100,
          speed: "--",
          eta: "--",
          done: true,
          file: `/api/file/${jobId}`,
          report: `/api/report/${jobId}`,
        });
      } catch (err) {
        console.error(err);
        setJob(jobId, {
          stage: "error",
          status: "Erro",
          error: err.message || "Falha ao finalizar",
          done: false,
        });
      } finally {
        busy = false;
      }
    });
  } catch (err) {
    console.error(err);
    setJob(jobId, {
      stage: "error",
      status: "Erro",
      error: err.message || "Erro ao iniciar download",
      done: false,
    });
    busy = false;
  }
}

app.post("/api/download", async (req, res) => {
  if (busy) {
    return res.status(429).json({ error: "Servidor ocupado" });
  }

  const { url, quality, clientId } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: "URL inválida" });
  }

  const jobId = String(clientId || createJobId());

  jobs[jobId] = {
    id: jobId,
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
    updatedAt: Date.now(),
  };

  busy = true;
  res.json({ jobId });

  processDownload(jobId, url, quality);
});

app.get("/api/status/:id", (req, res) => {
  const job = jobs[req.params.id];

  if (!job) {
    const file = path.join(DOWNLOAD_DIR, `${req.params.id}.mp4`);
    if (fs.existsSync(file)) {
      return res.json({
        id: req.params.id,
        stage: "finished",
        status: "Concluído",
        progress: 100,
        done: true,
        file: `/api/file/${req.params.id}`,
        report: `/api/report/${req.params.id}`,
      });
    }

    return res.status(404).json({ error: "Job não encontrado" });
  }

  return res.json(makePublicJob(job));
});

app.get("/api/file/:id", (req, res) => {
  const file = path.join(DOWNLOAD_DIR, `${req.params.id}.mp4`);

  if (!fs.existsSync(file)) {
    return res.status(404).send("Arquivo não encontrado");
  }

  const stat = fs.statSync(file);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}.mp4"`);

  return fs.createReadStream(file).pipe(res);
});

app.get("/api/report/:id", async (req, res) => {
  try {
    const file = path.join(DOWNLOAD_DIR, `${req.params.id}.mp4`);

    if (!fs.existsSync(file)) {
      return res.status(404).json({ error: "Arquivo não encontrado" });
    }

    const report = await probeFile(file);

    return res.json({
      id: req.params.id,
      ...report,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: err.message || "Falha ao gerar relatório",
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
