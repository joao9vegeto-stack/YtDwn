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

const io = new Server(server,{
  cors:{
    origin:"*"
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

const downloadsDir = path.join(__dirname,"downloads");

if(!fs.existsSync(downloadsDir)){
  fs.mkdirSync(downloadsDir);
}

app.get("/downloads/:file", (req, res) => {

    const filePath = path.join(downloadsDir, req.params.file);

    if(!fs.existsSync(filePath)){
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

    stream.pipe(res);

});

let busy = false;

app.post("/api/download", async(req,res)=>{

  if(busy){

    return res.status(429).json({
      error:"Servidor ocupado. Aguarde o download atual terminar."
    });

  }

  busy = true;

  const { url, quality } = req.body;

  const id = Date.now().toString();

  io.emit("progress",{
  id,
  title:"Preparando download...",
  thumbnail:"",
  stage:"starting",
  percent:0,
  speed:"--",
  eta:"--"
});

  try{

    const info = await ytDlp.getVideoInfo(url);

    const title = info.title || "Vídeo";

    const thumbnail =
      info.thumbnail ||
      (info.thumbnails?.length
        ? info.thumbnails[info.thumbnails.length - 1].url
        : "");

    const output = path.join(downloadsDir,`${id}.mp4`);

    io.emit("progress",{
      id,
      title,
      thumbnail,
      stage:"downloading",
      percent:0
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

yt.on("ytDlpEvent", (eventType, eventData) => {

  const text = eventData.toString();

  console.log(text);

  const match = text.match(
    /(\d+(?:\.\d+)?)%\s+of.*?at\s+([^\s]+).*?ETA\s+([0-9:]+)/
  );

  if(match){

    const percent = parseFloat(match[1]);
    const speed = match[2];
    const eta = match[3];

    io.emit("progress",{
      id,
      title,
      thumbnail,
      stage:"downloading",
      percent,
      speed,
      eta
    });

  }

});

   await yt.promise; 

    if(fs.existsSync(output)){

  io.emit("progress",{
    id,
    title,
    thumbnail,
    stage:"finished",
    percent:100
  });

  return res.json({
    success:true,
    download:`/downloads/${id}.mp4`
  });

}else{

  throw new Error("Arquivo final não encontrado");

}

    yt.on("close",()=>{

      let convert = 0;

      const interval = setInterval(()=>{

        convert += 5;

        io.emit("progress",{
          id,
          title,
          thumbnail,
          stage:"converting",
          percent:convert
        });

        if(convert >= 100){

          clearInterval(interval);

          io.emit("progress",{
            id,
            title,
            thumbnail,
            stage:"finished",
            percent:100,
            download:`/downloads/${id}.mp4`
          });

          busy = false;

        }

      },300);

    });

    yt.on("error",(err)=>{

      io.emit("progress",{
        id,
        stage:"error",
        message:"Erro ao processar vídeo"
      });

      busy = false;

    });

  }catch(err){

    busy = false;

    return res.status(500).json({
      error:"Erro ao obter vídeo"
    });

  }

});

server.listen(PORT,"0.0.0.0",()=>{

  console.log(`Servidor rodando na porta ${PORT}`);

});
