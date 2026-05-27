const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");
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

app.use(compression());
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));

if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

app.use("/downloads", express.static(downloadsDir, {
  fallthrough: false,
  maxAge: 0,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store");
  }
}));

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

let busy = false;

function emitProgress(payload) {
  io.emit("progress", payload);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEtaToSeconds(eta) {
  if (!eta || eta === "--" || eta === "Unknown") return null;

  const parts = String(eta).trim().split(":").map((n) => Number(n));
  if (parts.some((n) => Number.isNaN(n))) return null;

  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];

  return null;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--";

  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  return `${m}:${String(sec).padStart(2, "0")}`;
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

async function waitForMergedFile(id, timeout = 60000) {
  const exactPath = path.join(downloadsDir, `${id}.source.mp4`);
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (fs.existsSync(exactPath)) {
      return exactPath;
    }

    const candidates = fs
      .readdirSync(downloadsDir)
      .filter((name) => name.startsWith(`${id}.source`) && name.endsWith(".mp4"));

    if (candidates.length) {
      candidates.sort((a, b) => a.length - b.length);
      return path.join(downloadsDir, candidates[0]);
    }

    await sleep(250);
  }

  throw new Error("MP4 mesclado não encontrado");
}

function runFfmpegCfr30(inputPath, outputPath, durationSec, meta) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i", inputPath,
      "-vf", "fps=30",
      "-fps_mode", "cfr",
      "-r", "30",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-profile:v", "high",
      "-level", "4.0",
      "-pix_fmt", "yuv420p",
      "-g", "60",
      "-keyint_min", "60",
      "-sc_threshold", "0",
      "-c:a", "aac",
      "-b:a", "128k",
      "-ar", "44100",
      "-ac", "2",
      "-movflags", "+faststart",
      "-progress", "pipe:2",
      "-nostats",
      outputPath
    ];

    const ff = spawn("ffmpeg", args);

    let emaEta = null;
    let lastEmit = 0;
    let currentOutTimeSec = 0;

    ff.stderr.on("data", (chunk) => {
      const text = String(chunk || "");
      console.log(text);

      const lines = text.split(/\r?\n/).filter(Boolean);

      for (const line of lines) {
        if (line.startsWith("out_time_ms=")) {
          const value = Number(line.split("=").pop());
          if (Number.isFinite(value)) {
            currentOutTimeSec = value / 1_000_000;
          }
        } else if (line.startsWith("out_time_us=")) {
          const value = Number(line.split("=").pop());
          if (Number.isFinite(value)) {
            currentOutTimeSec = value / 1_000_000;
          }
        } else if (line.startsWith("progress=")) {
          const now = Date.now();
          const pct = durationSec > 0
            ? Math.min(100, Math.max(0.1, (currentOutTimeSec / durationSec) * 100))
            : 0;

          const elapsedSec = (now - meta.ffmpegStartedAt) / 1000;
          let etaSec = null;

          if (pct > 0.1) {
            etaSec = (elapsedSec / (pct / 100)) - elapsedSec;
            if (!Number.isFinite(etaSec) || etaSec < 0) etaSec = null;
          }

          if (etaSec !== null) {
            emaEta = emaEta === null ? etaSec : (emaEta * 0.75 + etaSec * 0.25);
          }

          if (now - lastEmit >= 400 || line.includes("progress=end")) {
            lastEmit = now;
            const emitPercent = Math.min(100, Math.max(0, Math.round(pct)));

            emitProgress({
              id: meta.id,
              title: meta.title,
              thumbnail: meta.thumbnail,
              stage: "merging",
              percent: emitPercent,
              speed: line.includes("progress=end") ? "--" : "renderizando",
              eta: line.includes("progress=end") ? "0:00" : formatEta(emaEta)
            });
          }
        }
      }
    });

    ff.on("error", reject);

    ff.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`FFmpeg saiu com código ${code}`));
    });
  });
}

async function processDownload({ id, url, quality }) {
  const info = await ytDlp.getVideoInfo(url);

  const title = info.title || "Vídeo";
  const thumbnail =
    info.thumbnail ||
    (info.thumbnails?.length
      ? info.thumbnails[info.thumbnails.length - 1].url
      : "");

  const safeQuality = String(quality || "1080").replace(/\D/g, "") || "1080";
  const outputTemplate = path.join(downloadsDir, `${id}.source.%(ext)s`);
  const finalPath = path.join(downloadsDir, `${id}.mp4`);

  cleanJobFiles(id);
  safeRemove(finalPath);

  emitProgress({
    id,
    title,
    thumbnail,
    stage: "starting",
    percent: 0,
    speed: "--",
    eta: "--"
  });

  let lastDownloadEta = null;
  let downloadEtaEma = null;
  let lastDownloadPct = 0;

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

  yt.on("ytDlpEvent", (_type, data) => {
    const text = String(data || "");
    console.log(text);

    const parsed = parseProgressLine(text);

    if (parsed) {
      const etaSec = parseEtaToSeconds(parsed.eta);

      if (etaSec !== null) {
        downloadEtaEma =
          downloadEtaEma === null ? etaSec : (downloadEtaEma * 0.7 + etaSec * 0.3);
        lastDownloadEta = formatEta(downloadEtaEma);
      }

      const stablePct = Math.max(lastDownloadPct, Math.floor(parsed.percent));
      lastDownloadPct = stablePct;

      emitProgress({
        id,
        title,
        thumbnail,
        stage: "downloading",
        percent: stablePct,
        speed: parsed.speed,
        eta: lastDownloadEta || parsed.eta || "--"
      });
    }

    if (text.includes("Merging formats into")) {
      emitProgress({
        id,
        title,
        thumbnail,
        stage: "merging",
        percent: 0,
        speed: "--",
        eta: "--"
      });
    }
  });

  await yt.promise;

  const mergedPath = await waitForMergedFile(id);

  emitProgress({
    id,
    title,
    thumbnail,
    stage: "merging",
    percent: 0,
    speed: "finalizando...",
    eta: "--"
  });

  const durationSec = Number(info.duration || 0) || 1;

  await runFfmpegCfr30(
    mergedPath,
    finalPath,
    durationSec,
    {
      id,
      title,
      thumbnail,
      ffmpegStartedAt: Date.now()
    }
  );

  safeRemove(mergedPath);

  emitProgress({
    id,
    title,
    thumbnail,
    stage: "finished",
    percent: 100,
    download: `/downloads/${id}.mp4`
  });

  return {
    success: true,
    download: `/downloads/${id}.mp4`
  };
}

app.post("/api/download", async (req, res) => {
  if (busy) {
    return res.status(429).json({
      error: "Servidor ocupado"
    });
  }

  const { url, quality, clientId } = req.body || {};

  if (!url) {
    return res.status(400).json({
      error: "URL inválida"
    });
  }

  const id = clientId || `job_${Date.now()}`;

  busy = true;

  res.status(202).json({
    success: true,
    id
  });

  processDownload({
    id,
    url,
    quality: quality || "1080"
  })
    .catch((err) => {
      console.error(err);

      emitProgress({
        id,
        stage: "error",
        message: err.message || "Erro ao processar vídeo"
      });
    })
    .finally(() => {
      busy = false;
    });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
