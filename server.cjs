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

const downloadsDir = path.join(__dirname, "downloads");

if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

app.use("/downloads", express.static(downloadsDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

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
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error(err);
  }
}

function waitForFile(filePath, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    const timer = setInterval(() => {
      if (fs.existsSync(filePath)) {
        clearInterval(timer);
        return resolve(true);
      }

      if (Date.now() - start > timeout) {
        clearInterval(timer);
        return reject(new Error("Arquivo final não encontrado"));
      }
    }, 300);
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

  const sourceTemplate = path.join(downloadsDir, `${id}.source.%(ext)s`);
const finalPath = path.join(downloadsDir, `${id}.final.mp4`);

safeRemove(finalPath);

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
    `bestvideo[height<=${quality}][vcodec*=avc1]+bestaudio[acodec*=mp4a]/bestvideo[height<=${quality}]+bestaudio/best`,

    "--merge-output-format",
    "mp4",

    "-o",
    sourceTemplate
  ]);

  yt.on("ytDlpEvent", (_type, data) => {
    const text = String(data || "");

    console.log(text);

    const progress = text.match(
      /(\d+(?:\.\d+)?)%\s+of.*?at\s+([^\s]+).*?ETA\s+([0-9:]+)/
    );

    if (progress) {
      emitProgress({
        id,
        title,
        thumbnail,
        stage: "downloading",
        percent: parseFloat(progress[1]),
        speed: progress[2],
        eta: progress[3]
      });
    }

    if (text.includes("Merging formats into")) {
      emitProgress({
        id,
        title,
        thumbnail,
        stage: "merging",
        percent: 100
      });
    }
  });

  await yt.promise;

const sourceBase = `${id}.source`;

const files = fs.readdirSync(downloadsDir);

const mergedFile = files.find(
  (f) =>
    f.startsWith(sourceBase) &&
    f.endsWith(".mp4")
);

if (!mergedFile) {
  throw new Error("MP4 mesclado não encontrado");
}

const mergedPath = path.join(downloadsDir, mergedFile);

await waitForFile(mergedPath);

emitProgress({
  id,
  title,
  thumbnail,
  stage: "converting",
  percent: 5
});

await new Promise((resolve, reject) => {
  ffmpeg(mergedPath)
    .videoCodec("libx264")
    .audioCodec("aac")
    .outputOptions([
      "-preset ultrafast",
      "-movflags +faststart"
    ])
    .save(finalPath)
    .on("progress", (p) => {
      emitProgress({
        id,
        title,
        thumbnail,
        stage: "converting",
        percent: Math.min(99, Math.floor(p.percent || 0))
      });
    })
    .on("end", resolve)
    .on("error", reject);
});

await waitForFile(finalPath);

emitProgress({
  id,
  title,
  thumbnail,
  stage: "finished",
  percent: 100,
  download: `/download/${path.basename(finalPath)}`
});


  const mergedFile = files.find(
    (f) =>
      f.startsWith(sourceBase) &&
      f.endsWith(".mp4")
  );

  if (!mergedFile) {
    throw new Error("MP4 mesclado não encontrado");
  }

  const mergedPath = path.join(downloadsDir, mergedFile);

  await waitForFile(mergedPath);

  emitProgress({
    id,
    title,
    thumbnail,
    stage: "converting",
    percent: 5
  });

  const ffmpegArgs = [
    "-y",

    "-i",
    mergedPath,

    "-c:v",
    "libx264",

    "-preset",
    "ultrafast",

    "-pix_fmt",
    "yuv420p",

    "-profile:v",
    "high",

    "-level",
    "4.0",

    "-movflags",
    "+faststart",

    "-r",
    "30",

    "-fps_mode",
    "cfr",

    "-g",
    "60",

    "-keyint_min",
    "60",

    "-sc_threshold",
    "0",

    "-c:a",
    "aac",

    "-b:a",
    "192k",

    "-ar",
    "48000",

    "-ac",
    "2",

    finalPath
  ];

  await new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", ffmpegArgs);

    ffmpeg.stderr.on("data", (data) => {
      const line = data.toString();

      console.log(line);

      const match = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);

      if (match) {
        const h = parseInt(match[1]);
        const m = parseInt(match[2]);
        const s = parseFloat(match[3]);

        const current = h * 3600 + m * 60 + s;
        const total = info.duration || 1;

        let percent = Math.floor((current / total) * 100);

        if (percent > 100) percent = 100;
        if (percent < 5) percent = 5;

        emitProgress({
          id,
          title,
          thumbnail,
          stage: "converting",
          percent
        });
      }
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error("Erro no FFmpeg"));
      }
    });
  });

  await waitForFile(finalPath);

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
    success: true
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
