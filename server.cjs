const express = require("express");
const cors = require("cors");
const compression = require("compression");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();

app.use(cors());

app.use(
  compression({
    level: 6,
    threshold: 0
  })
);

app.use(express.json({ limit: "10mb" }));

const DOWNLOAD_DIR = "/tmp/ytdwn";

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

const jobs = {};

function cleanupOldFiles() {
  const now = Date.now();

  fs.readdirSync(DOWNLOAD_DIR).forEach((file) => {
    const filePath = path.join(DOWNLOAD_DIR, file);

    try {
      const stat = fs.statSync(filePath);

      if (now - stat.mtimeMs > 1000 * 60 * 30) {
        fs.unlinkSync(filePath);
      }
    } catch {}
  });
}

setInterval(cleanupOldFiles, 1000 * 60 * 5);

app.post("/api/download", async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        error: "URL inválida"
      });
    }

    const jobId = Date.now().toString();

    const output = path.join(DOWNLOAD_DIR, `${jobId}.mp4`);

    jobs[jobId] = {
      progress: 0,
      status: "Baixando...",
      speed: "0 MB/s",
      eta: "--:--",
      file: null,
      done: false,
      error: null
    };

    res.json({
      jobId
    });

    const args = [
      "-f",
      "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]",
      "--merge-output-format",
      "mp4",

      "--downloader",
      "aria2c",

      "--downloader-args",
      "aria2c:-x 16 -s 16 -k 1M",

      "--newline",

      "--progress",

      "-o",
      output,

      url
    ];

    const yt = spawn("yt-dlp", args);

    yt.stdout.on("data", (data) => {
      const text = data.toString();

      console.log(text);

      const match = text.match(
        /(\d+(?:\.\d+)?)%.*?at\s+([0-9.]+\w+\/s).*?ETA\s+([0-9:]+)/
      );

      if (match) {
        jobs[jobId].progress = parseFloat(match[1]);
        jobs[jobId].speed = match[2];
        jobs[jobId].eta = match[3];
        jobs[jobId].status = "Baixando...";
      }

      if (text.includes("Merging formats")) {
        jobs[jobId].status = "Finalizando MP4...";
      }
    });

    yt.stderr.on("data", (data) => {
      console.log(data.toString());
    });

    yt.on("close", (code) => {
      if (code !== 0) {
        jobs[jobId].error = "Falha no download";
        return;
      }

      if (!fs.existsSync(output)) {
        jobs[jobId].error = "Arquivo final não encontrado";
        return;
      }

      jobs[jobId].progress = 100;
      jobs[jobId].status = "Concluído";
      jobs[jobId].done = true;
      jobs[jobId].file = `/api/file/${jobId}`;
    });
  } catch (err) {
    console.error(err);
  }
});

app.get("/api/status/:id", (req, res) => {
  const job = jobs[req.params.id];

  if (!job) {
    return res.status(404).json({
      error: "Job não encontrado"
    });
  }

  res.json(job);
});

app.get("/api/file/:id", (req, res) => {
  const file = path.join(DOWNLOAD_DIR, `${req.params.id}.mp4`);

  if (!fs.existsSync(file)) {
    return res.status(404).send("Arquivo não encontrado");
  }

  res.download(file);
});

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});
