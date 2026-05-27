import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import crypto from "crypto";

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath.path);

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const DOWNLOAD_DIR = "/tmp/ytdwn";

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

const jobs = {};

function createJob() {
  return crypto.randomUUID();
}

function sanitize(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanup(file) {
  setTimeout(() => {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch {}
  }, 1000 * 60 * 20);
}

app.post("/api/download", async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        error: "URL ausente"
      });
    }

    const jobId = createJob();

    jobs[jobId] = {
      status: "starting",
      progress: 0,
      speed: "",
      eta: "",
      file: null,
      title: "Video"
    };

    res.json({ jobId });

    const tempBase = path.join(DOWNLOAD_DIR, jobId);

    const outputTemplate = `${tempBase}.%(ext)s`;

    const ytDlpCmd = [
      "yt-dlp",
      "--newline",
      "--progress",
      "-f",
      "bv*+ba/b",
      "--merge-output-format",
      "mp4",
      "--no-playlist",
      "--remux-video",
      "mp4",
      "-o",
      `"${outputTemplate}"`,
      `"${url}"`
    ].join(" ");

    const process = exec(ytDlpCmd, {
      maxBuffer: 1024 * 1024 * 50
    });

    let finalFile = null;

    process.stdout.on("data", data => {
      const text = data.toString();

      console.log(text);

      const percentMatch = text.match(/(\d+\.\d+)%/);

      if (percentMatch) {
        jobs[jobId].status = "downloading";
        jobs[jobId].progress = parseFloat(percentMatch[1]);
      }

      const speedMatch = text.match(/at\s+([^\s]+)/);

      if (speedMatch) {
        jobs[jobId].speed = speedMatch[1];
      }

      const etaMatch = text.match(/ETA\s+([0-9:]+)/);

      if (etaMatch) {
        jobs[jobId].eta = etaMatch[1];
      }

      if (text.includes("Merging formats")) {
        jobs[jobId].status = "processing";
        jobs[jobId].progress = 99;
      }

      const destinationMatch = text.match(/\[download\] Destination:\s(.+)/);

      if (destinationMatch) {
        finalFile = destinationMatch[1].trim();
      }
    });

    process.stderr.on("data", data => {
      console.log(data.toString());
    });

    process.on("close", async code => {
      try {
        if (code !== 0) {
          jobs[jobId].status = "error";
          return;
        }

        const files = fs.readdirSync(DOWNLOAD_DIR);

        const mp4 = files.find(f =>
          f.startsWith(jobId) &&
          f.endsWith(".mp4")
        );

        if (!mp4) {
          jobs[jobId].status = "error";
          return;
        }

        const fullPath = path.join(DOWNLOAD_DIR, mp4);

        const stat = fs.statSync(fullPath);

        if (stat.size < 500000) {
          jobs[jobId].status = "error";
          return;
        }

        jobs[jobId].status = "finished";
        jobs[jobId].progress = 100;
        jobs[jobId].file = `/api/file/${mp4}`;

        cleanup(fullPath);

      } catch (err) {
        console.log(err);

        jobs[jobId].status = "error";
      }
    });

  } catch (err) {
    console.log(err);
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

app.get("/api/file/:file", (req, res) => {
  try {
    const file = path.join(DOWNLOAD_DIR, req.params.file);

    if (!fs.existsSync(file)) {
      return res.status(404).send("Arquivo não existe");
    }

    const stat = fs.statSync(file);

    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": stat.size,
      "Content-Disposition": `attachment; filename="${path.basename(file)}"`
    });

    fs.createReadStream(file).pipe(res);

  } catch (err) {
    console.log(err);

    res.status(500).send("Erro");
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
