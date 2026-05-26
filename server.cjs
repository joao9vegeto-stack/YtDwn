const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const YTDlpWrap = require("yt-dlp-wrap").default;

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const PORT = process.env.PORT || 3000;

const DOWNLOAD_DIR = path.join(__dirname, "downloads");

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

app.use(express.static(path.join(__dirname, "public")));
app.use("/downloads", express.static(DOWNLOAD_DIR));

const ytDlp = new YTDlpWrap();

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, "_")
    .trim();
}

function getProgressPercent(line) {
  const match = line.match(/(\d+(?:\.\d+)?)%/);

  if (!match) return 0;

  return parseFloat(match[1]);
}

io.on("connection", (socket) => {
  console.log("Cliente conectado");

  socket.on("start-download", async ({ url, quality }) => {
    const jobId = Date.now().toString();

    try {
      socket.emit("progress", {
        id: jobId,
        stage: "starting",
        progress: 0,
        message: "Obtendo informações..."
      });

      const infoRaw = await ytDlp.execPromise([
        "--dump-json",
        url
      ]);

      const info = JSON.parse(infoRaw);

      const title = sanitizeFilename(info.title || "video");
      const thumbnail = info.thumbnail || "";

      socket.emit("progress", {
        id: jobId,
        title,
        thumbnail,
        stage: "downloading",
        progress: 0,
        message: "Baixando vídeo..."
      });

      const tempBase = path.join(DOWNLOAD_DIR, `job_${jobId}`);
      const mergedFile = `${tempBase}.merged.mp4`;
      const finalFile = `${tempBase}.mp4`;

      const yt = ytDlp.exec([
        url,
        "-f",
        quality || "bestvideo+bestaudio",
        "--merge-output-format",
        "mp4",
        "-o",
        mergedFile
      ]);

      yt.on("progress", (progress) => {
        socket.emit("progress", {
          id: jobId,
          title,
          thumbnail,
          stage: "downloading",
          progress: Math.floor(progress.percent || 0),
          message: `Baixando... ${Math.floor(progress.percent || 0)}%`
        });
      });

      yt.on("ytDlpEvent", (type, data) => {
        console.log(type, data);
      });

      yt.on("error", (err) => {
        console.error(err);

        socket.emit("progress", {
          id: jobId,
          title,
          thumbnail,
          stage: "error",
          progress: 0,
          message: "Erro no download"
        });
      });

      yt.on("close", async () => {
        try {
          if (!fs.existsSync(mergedFile)) {
            socket.emit("progress", {
              id: jobId,
              title,
              thumbnail,
              stage: "error",
              progress: 0,
              message: "Arquivo intermediário não encontrado"
            });

            return;
          }

          socket.emit("progress", {
            id: jobId,
            title,
            thumbnail,
            stage: "converting",
            progress: 0,
            message: "Convertendo para MP4 H264/AAC..."
          });

          const ffmpegCmd = `
ffmpeg -y -i "${mergedFile}" \
-c:v libx264 \
-preset ultrafast \
-crf 23 \
-c:a aac \
-b:a 192k \
-movflags +faststart \
"${finalFile}"
`;

          const ffmpeg = exec(ffmpegCmd);

          ffmpeg.stderr.on("data", (data) => {
            console.log(data.toString());
          });

          ffmpeg.on("close", () => {
            try {
              if (!fs.existsSync(finalFile)) {
                socket.emit("progress", {
                  id: jobId,
                  title,
                  thumbnail,
                  stage: "error",
                  progress: 0,
                  message: "Arquivo final não encontrado"
                });

                return;
              }

              fs.unlinkSync(mergedFile);

              socket.emit("progress", {
                id: jobId,
                title,
                thumbnail,
                stage: "finished",
                progress: 100,
                download: `/downloads/${path.basename(finalFile)}`,
                message: "Conversão concluída"
              });
            } catch (err) {
              console.error(err);

              socket.emit("progress", {
                id: jobId,
                title,
                thumbnail,
                stage: "error",
                progress: 0,
                message: "Erro ao finalizar conversão"
              });
            }
          });
        } catch (err) {
          console.error(err);

          socket.emit("progress", {
            id: jobId,
            title,
            thumbnail,
            stage: "error",
            progress: 0,
            message: "Erro na conversão"
          });
        }
      });
    } catch (err) {
      console.error(err);

      socket.emit("progress", {
        id: jobId,
        stage: "error",
        progress: 0,
        message: "Erro ao iniciar download"
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
