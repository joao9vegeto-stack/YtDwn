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

app.use(compression());
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const downloadsDir = path.join(__dirname, "downloads");
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

app.use("/downloads", express.static(downloadsDir));

app.get("/health", (req, res) => {
  res.json({ status: "online" });
});

let busy = false;

function emitProgress(payload) {
  io.emit("progress", payload);
}

function safeRemove(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
  } catch (err) {
    console.error("Erro ao remover arquivo:", err);
  }
}

function waitForFile(filePath, timeoutMs = 60000, intervalMs = 250) {
  return new Promise((resolve, reject) => {
    const started = Date.now();

    const tick = () => {
      if (fs.existsSync(filePath)) return resolve(true);

      if (Date.now() - started >= timeoutMs) {
        return reject(new Error("Arquivo final não encontrado"));
      }

      setTimeout(tick, intervalMs);
    };

    tick();
  });
}

function parseDurationToSeconds(duration) {
  const n = Number(duration || 0);
  return Number.isFinite(n) ? n : 0;
}

function parseProgressSeconds(line) {
  const match = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;

  const h = Number(match[1]);
  const m = Number(match[2]);
  const s = Number(match[3]);
  if (![h, m, s].every(Number.isFinite)) return null;

  return h * 3600 + m * 60 + s;
}

function runFfmpegTranscode({ inputPath, outputPath, durationSeconds, id, title, thumbnail }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i", inputPath,

      // Perfil igual ao arquivo final “bom”
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-profile:v", "baseline",
      "-level", "4.2",
      "-pix_fmt", "yuv420p",
      "-r", "30",
      "-fps_mode", "cfr",
      "-g", "60",
      "-keyint_min", "31",
      "-sc_threshold", "0",
      "-bf", "0",

      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "44100",
      "-ac", "2",

      "-movflags", "+faststart",
      "-progress", "pipe:1",
      "-nostats",
      outputPath
    ];

    const ffmpeg = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let latestPercent = 0;
    let stdoutBuffer = "";

    ffmpeg.stdout.on("data", (chunk) => {
      stdoutBuffer += String(chunk || "");

      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const currentSeconds = parseProgressSeconds(line);
        if (currentSeconds !== null && durationSeconds > 0) {
          const percent = Math.min(99, Math.floor((currentSeconds / durationSeconds) * 100));
          if (percent > latestPercent) {
            latestPercent = percent;
            emitProgress({
              id,
              title,
              thumbnail,
              stage: "converting",
              percent,
              speed: "FFmpeg",
              eta: "--"
            });
          }
        }
      }
    });

    ffmpeg.stderr.on("data", (chunk) => {
      const text = String(chunk || "");
      console.log(text);
    });

    ffmpeg.on("error", reject);

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        emitProgress({
          id,
          title,
          thumbnail,
          stage: "converting",
          percent: 100,
          speed: "FFmpeg",
          eta: "--"
        });
        resolve();
      } else {
        reject(new Error(`FFmpeg terminou com código ${code}`));
      }
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

  const durationSeconds = parseDurationToSeconds(info.duration);

  const sourcePath = path.join(downloadsDir, `${id}.source.%(ext)s`);
  const finalPath = path.join(downloadsDir, `${id}.mp4`);

  safeRemove(finalPath);

  emitProgress({
    id,
    title: "Preparando download...",
    thumbnail: "",
    stage: "starting",
    percent: 0,
    speed: "Conectando...",
    eta: "--"
  });

  emitProgress({
    id,
    title,
    thumbnail,
    stage: "downloading",
    percent: 0,
    speed: "--",
    eta: "--"
  });

  const yt = ytDlp.exec([
    url,
    "--no-playlist",
    "-f",
    `bestvideo[height<=${quality}]+bestaudio/best`,
    "--merge-output-format",
    "mp4",
    "-o",
    sourcePath
  ]);

  yt.on("ytDlpEvent", (_eventType, eventData) => {
    const text = String(eventData ?? "");
    console.log(text);

    if (text.includes("Merging formats into")) {
      emitProgress({
        id,
        title,
        thumbnail,
        stage: "merging",
        percent: 100,
        speed: "Finalizando...",
        eta: "--"
      });
      return;
    }

    const match = text.match(
      /(\d+(?:\.\d+)?)%\s+of.*?at\s+([^\s]+).*?ETA\s+([0-9:]+)/
    );

    if (match) {
      emitProgress({
        id,
        title,
        thumbnail,
        stage: "downloading",
        percent: Number.parseFloat(match[1]),
        speed: match[2],
        eta: match[3]
      });
    }
  });

  yt.on("error", (err) => {
    console.error("yt-dlp error:", err);
  });

  await yt.promise;

  // yt-dlp pode gerar .mp4, .mkv ou .webm; achamos o arquivo real
  const sourceBase = path.basename(sourcePath).replace(/\.%\(ext\)s$/, "");
  const sourceFile = fs
    .readdirSync(downloadsDir)
    .find((f) => f.startsWith(sourceBase + "."));

  if (!sourceFile) {
    throw new Error("Arquivo fonte não encontrado");
  }

  const realSourcePath = path.join(downloadsDir, sourceFile);
  await waitForFile(realSourcePath, 60000);

  emitProgress({
    id,
    title,
    thumbnail,
    stage: "converting",
    percent: 0,
    speed: "FFmpeg",
    eta: "--"
  });

  await runFfmpegTranscode({
    inputPath: realSourcePath,
    outputPath: finalPath,
    durationSeconds,
    id,
    title,
    thumbnail
  });

  safeRemove(realSourcePath);

  if (!fs.existsSync(finalPath)) {
    throw new Error("Arquivo final não encontrado");
  }

  emitProgress({
    id,
    title,
    thumbnail,
    stage: "finished",
    percent: 100,
    download: `/downloads/${id}.mp4`
  });

  return {
    id,
    title,
    thumbnail,
    download: `/downloads/${id}.mp4`
  };
}

app.post("/api/download", async (req, res) => {
  if (busy) {
    return res.status(429).json({
      error: "Servidor ocupado. Aguarde o download atual terminar."
    });
  }

  const { url, quality, clientId } = req.body || {};

  if (!url) {
    return res.status(400).json({
      error: "URL inválida"
    });
  }

  const id = String(clientId || Date.now());

  busy = true;

  // A UI recebe os eventos de progresso via socket.
  // A resposta só confirma que o job começou.
  res.status(202).json({
    success: true,
    id
  });

  processDownload({ id, url, quality: quality || "1080" })
    .catch((err) => {
      console.error(err);

      emitProgress({
        id,
        stage: "error",
        message: err?.message || "Erro ao processar vídeo"
      });
    })
    .finally(() => {
      busy = false;
    });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
