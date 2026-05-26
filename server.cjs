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

app.use(compression());
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));

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
      const merged = candidates.find((name) => name.endsWith(".source.mp4"));
      if (merged) {
        return path.join(downloadsDir, merged);
      }
    }

    await sleep(300);
  }

  throw new Error("MP4 mesclado não encontrado");
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
        percent: 100,
        speed: "--",
        eta: "--"
      });
    }
  });

  await yt.promise;

  const mergedPath = await waitForMergedFile(id);

  safeRemove(finalPath);
  fs.renameSync(mergedPath, finalPath);

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
