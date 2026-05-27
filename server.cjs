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
app.use(express.json({ limit: "10mb" }));

app.use(
  compression({
    level: 6,
    threshold: 0,
  })
);

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

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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

async function getVideoInfo(url) {
  const { stdout } = await runCommand("yt-dlp", [
    "-J",
    "--no-playlist",
    url,
  ]);

  const info = JSON.parse(stdout);
  return {
    title: info.title || "Vídeo",
    thumbnail:
      info.thumbnail ||
      (Array.isArray(info.thumbnails) && info.thumbnails.length
        ? info.thumbnails[info.thumbnails.length - 1].url
        : ""),
  };
}

function parsePercent(text) {
  const match = text.match(/(\d+(?:\.\d+)?)%/);
  if (!match) return null;
  return Number.parseFloat(match[1]);
}

function parseSpeed(text) {
  const m1 = text.match(/DL:([0-9.]+\w+)/i);
  if (m1) return m1[1];

  const m2 = text.match(/at\s+([0-9.]+\w+\/s)/i);
  if (m2) return m2[1];

  return null;
}

function parseEta(text) {
  const m1 = text.match(/ETA:?(\s*[0-9:]+|[0-9]+s|Unknown)/i);
  if (m1) return m1[1].trim();

  return null;
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

async function processDownload(jobId, url) {
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

    const info = await getVideoInfo(url);
    setJob(jobId, {
      title: info.title,
      thumbnail: info.thumbnail,
    });

    const yt = spawn("yt-dlp", [
      "--no-playlist",
      "--newline",
      "--progress",
      "--downloader",
      "aria2c",
      "--downloader-args",
      "aria2c:-x 16 -s 16 -k 1M",
      "-f",
      "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]",
      "--merge-output-format",
      "mp4",
      "-o",
      outputTemplate,
      url,
    ]);

    yt.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      console.log(text);

      const percent = parsePercent(text);
      const speed = parseSpeed(text);
      const eta = parseEta(text);

      if (typeof percent === "number") {
        setJob(jobId, {
          stage: "downloading",
          status: "Baixando...",
          progress: Math.max(0, Math.min(100, percent)),
          speed: speed || job.speed || "--",
          eta: eta || job.eta || "--",
        });
      }

      if (text.includes("Merging formats")) {
        setJob(jobId, {
          stage: "processing",
          status: "Mesclando formatos...",
          progress: 99,
          speed: "--",
          eta: "0:05",
        });
      }
    });

    yt.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      console.log(text);

      if (text.includes("Merging formats")) {
        setJob(jobId, {
          stage: "processing",
          status: "Mesclando formatos...",
          progress: 99,
          speed: "--",
          eta: "0:05",
        });
      }
    });

    yt.on("close", () => {
      try {
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
        });
      } catch (err) {
        console.error(err);
        setJob(jobId, {
          stage: "error",
          status: "Erro",
          error: err.message || "Falha ao finalizar",
          done: false,
        });
      }
    });

    yt.on("error", (err) => {
      console.error(err);
      setJob(jobId, {
        stage: "error",
        status: "Erro",
        error: err.message || "Erro ao processar vídeo",
        done: false,
      });
    });
  } catch (err) {
    console.error(err);
    setJob(jobId, {
      stage: "error",
      status: "Erro",
      error: err.message || "Erro ao iniciar download",
      done: false,
    });
  }
}

app.post("/api/download", async (req, res) => {
  if (busy) {
    return res.status(429).json({ error: "Servidor ocupado" });
  }

  const { url } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: "URL inválida" });
  }

  const jobId = createJobId();

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
    error: "",
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };

  busy = true;

  res.json({ jobId });

  processDownload(jobId, url).finally(() => {
    busy = false;
  });
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

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}.mp4"`);

  return res.download(file, `${req.params.id}.mp4`);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
