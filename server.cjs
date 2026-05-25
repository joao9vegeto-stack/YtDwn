const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 7860;

/*
========================================
MIDDLEWARES
========================================
*/

app.use(cors());

app.use(express.json({
  limit: "10mb"
}));

app.use(express.urlencoded({
  extended: true
}));

/*
========================================
SERVIR FRONTEND
========================================
*/

app.use(express.static(__dirname));

/*
========================================
PASTA DOWNLOADS
========================================
*/

const downloadsDir = path.join(__dirname, "downloads");

if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir);
}

app.use("/downloads", express.static(downloadsDir));

/*
========================================
ROTAS BÁSICAS
========================================
*/

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    status: "online"
  });
});

app.get("/status", (req, res) => {
  res.json({
    running: true,
    port: PORT
  });
});

app.get("/api/test", (req, res) => {
  res.json({
    ok: true
  });
});

/*
========================================
DOWNLOAD YOUTUBE
========================================
*/

app.post("/api/download", async (req, res) => {

  try {

    const { url, quality } = req.body;

    if (!url) {
      return res.status(400).json({
        error: "URL inválida"
      });
    }

    const id = Date.now().toString();

    const outputTemplate = path.join(
      downloadsDir,
      `${id}.%(ext)s`
    );

    /*
    ========================================
    FORMATOS
    ========================================
    */

    let format = "bv*+ba/b";

    if (quality === "720") {
      format = "bv*[height<=720]+ba/b";
    }

    if (quality === "1080") {
      format = "bv*[height<=1080]+ba/b";
    }

    /*
    ========================================
    EXECUTAR YT-DLP
    ========================================
    */

    const yt = spawn("yt-dlp", [
      "-f",
      format,

      "--merge-output-format",
      "mp4",

      "--no-playlist",

      "-o",
      outputTemplate,

      url
    ]);

    let stderr = "";

    yt.stdout.on("data", (data) => {
      console.log(data.toString());
    });

    yt.stderr.on("data", (data) => {
      stderr += data.toString();
      console.log(data.toString());
    });

    yt.on("close", (code) => {

      if (code !== 0) {

        return res.status(500).json({
          error: "Erro ao baixar vídeo",
          details: stderr
        });

      }

      /*
      ========================================
      ENCONTRAR ARQUIVO GERADO
      ========================================
      */

      const files = fs.readdirSync(downloadsDir);

      const videoFile = files.find(file =>
        file.startsWith(id + ".")
      );

      if (!videoFile) {

        return res.status(500).json({
          error: "Arquivo não encontrado"
        });

      }

      /*
      ========================================
      RETORNAR LINK
      ========================================
      */

      return res.json({
        success: true,
        file: videoFile,
        download: `/downloads/${videoFile}`
      });

    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: "Erro interno"
    });

  }

});

/*
========================================
404
========================================
*/

app.use((req, res) => {

  res.status(404).json({
    error: "Rota não encontrada"
  });

});

/*
========================================
START
========================================
*/

app.listen(PORT, "0.0.0.0", () => {

  console.log(`Servidor rodando na porta ${PORT}`);

});
