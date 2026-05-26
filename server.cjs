const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const http = require("http");
const compression = require("compression");
const { spawn } = require("child_process");

const { Server } = require("socket.io");
const YTDlpWrap = require("yt-dlp-wrap").default;

const app = express();
app.use(compression());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const PORT = process.env.PORT || 3000;
const ytDlp = new YTDlpWrap();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const downloadsDir = path.join(__dirname, "downloads");

if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

app.get("/downloads/:file", (req, res) => {
  const filePath = path.join(downloadsDir, req.params.file);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Arquivo não encontrado");
  }

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.file}"`);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "public, max-age=31536000");
  res.setHeader("X-Accel-Buffering", "no");

  const stat = fs.statSync(filePath);
  res.setHeader("Content-Length", stat.size);

  const stream = fs.createReadStream(filePath);

  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).end("Erro ao enviar arquivo");
    } else {
      res.destroy();
    }
  });

  stream.pipe(res);
});

let busy = false;

function emitProgress(payload) {
  io.emit("progress", payload);
}

function waitForFile(filePath, timeoutMs = 60000, intervalMs = 250) {
  return new Promise((resolve, reject) => {
    const started = Date.now();

    const tick = () => {
      if (fs.existsSync(filePath)) {
        resolve(true);
        return;
      }

      if (Date.now() - started >= timeoutMs) {
        reject(new Error("Arquivo final não encontrado"));
        return;
      }

      setTimeout(tick, intervalMs);
    };

    tick();
  });
}

function runFfmpegTranscode({ inputPath, outputPath, durationSeconds, id, title, thumbnail }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i", inputPath,
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-r", "30",
      "-vsync", "cfr",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      "-progress", "pipe:1",
      "-nostats",
      outputPath
    ];

    const ffmpeg = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let latestPercent = 0;

    const handleProgressChunk = (chunk) => {
      const text = String(chunk || "");
      const lines = text.split(/\r?\n/);

      for (const line of lines) {
        if (!line.trim()) continue;

        if (line.startsWith("out_time_ms=")) {
          const outTimeMs = Number(line.replace("out_time_ms=", "").trim());
          if (Number.isFinite(outTimeMs) && durationSeconds > 0) {
            const percent = Math.min(99, Math.floor((outTimeMs / 1000000 / durationSeconds) * 100));
            if (percent >= latestPercent) {
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

        if (line === "progress=end") {
          emitProgress({
            id,
            title,
            thumbnail,
            stage: "converting",
            percent: 100,
            speed: "FFmpeg",
            eta: "--"
          });
        }
      }
    };

    ffmpeg.stdout.on("data", handleProgressChunk);

    ffmpeg.stderr.on("data", (chunk) => {
      const text = String(chunk || "");
      console.log(text);
    });

    ffmpeg.on("error", reject);

    ffmpeg.on("close", (code) => {
      if (code === 0) {
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

  const mergedPath = path.join(downloadsDir, `${id}.merged.mp4`);
  const finalPath = path.join(downloadsDir, `${id}.mp4`);

  if (fs.existsSync(mergedPath)) fs.rmSync(mergedPath, { force: true });
  if (fs.existsSync(finalPath)) fs.rmSync(finalPath, { force: true });

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
    "-f",
    `bestvideo[height<=${quality}]+bestaudio/best`,
    "--merge-output-format",
    "mp4",
    "-o",
    mergedPath
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
      const percent = Number.parseFloat(match[1]);
      const speed = match[2];
      const eta = match[3];

      emitProgress({
        id,
        title,
        thumbnail,
        stage: "downloading",
        percent,
        speed,
        eta
      });
    }
  });

  await yt.promise;

  await waitForFile(mergedPath, 60000);

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
    inputPath: mergedPath,
    outputPath: finalPath,
    durationSeconds: Number(info.duration || 0),
    id,
    title,
    thumbnail
  });

  if (fs.existsSync(mergedPath)) {
    fs.rmSync(mergedPath, { force: true });
  }

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

  const { url, quality } = req.body || {};

  if (!url) {
    return res.status(400).json({
      error: "URL inválida"
    });
  }

  const id = Date.now().toString();

  busy = true;

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
