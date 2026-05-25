
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 7860;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const downloads = path.join(__dirname, "downloads");
if (!fs.existsSync(downloads)) fs.mkdirSync(downloads);

app.post("/api/download", async (req, res) => {
  const { url, quality } = req.body;

  if (!url) {
    return res.status(400).json({ error: "URL inválida" });
  }

  const id = Date.now().toString();
  const output = path.join(downloads, `${id}.mp4`);

  const yt = spawn("yt-dlp", [
    "-f",
    quality || "bv*[height<=1080]+ba/b",
    "--merge-output-format",
    "mp4",
    "-o",
    output,
    url
  ]);

  yt.stderr.on("data", (d) => {
    console.log(d.toString());
  });

  yt.on("close", (code) => {
    if (code !== 0) {
      return;
    }
  });

  res.json({
    success: true,
    id,
    download: `/downloads/${id}.mp4`
  });
});

app.use("/downloads", express.static(downloads));

app.listen(PORT, "0.0.0.0", () => {
  console.log("Servidor rodando na porta " + PORT);
});
