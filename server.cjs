const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const http = require("http");
const compression = require("compression");

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

async function processDownload({ id, url, quality }) {
  let title = "Vídeo";
  let thumbnail = "";

  emitProgress({
    id,
    title: "Preparando download...",
    thumbnail: "",
    stage: "starting",
    percent: 0,
    speed: "Conectando...",
    eta: "--"
  });

  const info = await ytDlp.getVideoInfo(url);

  title = info.title || "Vídeo";
  thumbnail =
    info.thumbnail ||
    (info.thumbnails?.length
      ? info.thumbnails[info.thumbnails.length - 1].url
      : "");

  const output = path.join(downloadsDir, `${id}.mp4`);

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
    output
  ]);

  yt.on("ytDlpEvent", (_eventType, eventData) => {
    const text = String(eventData ?? "");

    console.log(text);

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

  if (!fs.existsSync(output)) {
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
