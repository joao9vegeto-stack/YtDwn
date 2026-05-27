const express = require('express');
const cors = require('cors');
const compression = require('compression');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = path.join('/tmp', 'ytdwn');
const jobs = Object.create(null);
let busy = false;

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(compression({ filter: (req, res) => !req.path.startsWith('/api/file/') && compression.filter(req, res) }));
app.use(express.static(path.join(__dirname, 'public')));

function now() {
  return Date.now();
}

function safeUnlink(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error(err);
  }
}

function cleanupOldFiles() {
  try {
    const ttl = 1000 * 60 * 60;
    const cutoff = now() - ttl;
    for (const file of fs.readdirSync(DOWNLOAD_DIR)) {
      const fp = path.join(DOWNLOAD_DIR, file);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) safeUnlink(fp);
      } catch {}
    }
  } catch (err) {
    console.error(err);
  }
}
setInterval(cleanupOldFiles, 1000 * 60 * 10).unref();

function createJobId() {
  return `job_${now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function publicJob(job) {
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
    reportReady: !!job.reportReady
  };
}

function emitJob(job) {
  job.updatedAt = now();
  io.emit('progress', publicJob(job));
}

function setJob(id, patch) {
  const job = jobs[id];
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: now() });
  emitJob(job);
  return job;
}

function parseEtaToSeconds(eta) {
  if (!eta || eta === '--' || eta === 'Unknown') return null;
  const parts = String(eta).trim().split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || null;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function parseProgressLine(text) {
  const m = text.match(/(\d+(?:\.\d+)?)%\s+of.*?at\s+([^\s]+).*?ETA\s+([0-9:]+|Unknown)/i);
  if (!m) return null;
  return { percent: Number.parseFloat(m[1]), speed: m[2], eta: m[3] };
}

function findFinalMp4(id) {
  const exact = path.join(DOWNLOAD_DIR, `${id}.mp4`);
  if (fs.existsSync(exact)) return exact;
  const candidates = fs.readdirSync(DOWNLOAD_DIR)
    .filter((name) => name.startsWith(id) && name.endsWith('.mp4') && !name.endsWith('.part.mp4'))
    .map((name) => path.join(DOWNLOAD_DIR, name));
  if (!candidates.length) return null;
  candidates.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return candidates[0];
}

function spawnCollect(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `${cmd} failed with code ${code}`));
    });
  });
}

async function getVideoInfo(url) {
  const { stdout } = await spawnCollect('yt-dlp', ['-J', '--no-playlist', url], { maxBuffer: 1024 * 1024 * 5 });
  const info = JSON.parse(stdout);
  return {
    title: info.title || 'Vídeo',
    thumbnail: info.thumbnail || (Array.isArray(info.thumbnails) && info.thumbnails.length ? info.thumbnails[info.thumbnails.length - 1].url : '')
  };
}

async function buildReport(filePath) {
  const { stdout } = await spawnCollect('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ], { maxBuffer: 1024 * 1024 * 8 });

  const data = JSON.parse(stdout);
  const format = data.format || {};
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const v = streams.find((s) => s.codec_type === 'video') || {};
  const a = streams.find((s) => s.codec_type === 'audio') || {};
  const fps = (v.avg_frame_rate && v.avg_frame_rate !== '0/0') ? (() => {
    const [n, d] = v.avg_frame_rate.split('/').map(Number);
    return n && d ? Number((n / d).toFixed(3)) : null;
  })() : null;

  const sizeBytes = fs.statSync(filePath).size;
  return {
    file: path.basename(filePath),
    sizeBytes,
    sizeMB: Number((sizeBytes / (1024 * 1024)).toFixed(2)),
    durationSeconds: Number.parseFloat(format.duration || '0') || null,
    formatName: format.format_name || null,
    formatLongName: format.format_long_name || null,
    video: {
      codec: v.codec_name || null,
      codecLongName: v.codec_long_name || null,
      profile: v.profile || null,
      width: v.width || null,
      height: v.height || null,
      pixFmt: v.pix_fmt || null,
      fps,
      bitrate: v.bit_rate ? Number(v.bit_rate) : null,
      colorSpace: v.color_space || null
    },
    audio: {
      codec: a.codec_name || null,
      codecLongName: a.codec_long_name || null,
      profile: a.profile || null,
      sampleRate: a.sample_rate ? Number(a.sample_rate) : null,
      channels: a.channels || null,
      channelLayout: a.channel_layout || null,
      bitrate: a.bit_rate ? Number(a.bit_rate) : null
    }
  };
}

async function processDownload(jobId, url, quality) {
  const job = jobs[jobId];
  const safeQuality = String(quality || '1080').replace(/\D/g, '') || '1080';
  const outputTemplate = path.join(DOWNLOAD_DIR, `${jobId}.%(ext)s`);

  try {
    const info = await getVideoInfo(url);
    setJob(jobId, { title: info.title, thumbnail: info.thumbnail, stage: 'starting', status: 'Preparando download...', progress: 0, speed: 'Conectando...', eta: '--', error: '' });

    const args = [
      '--no-playlist',
      '--newline',
      '--progress',
      '--downloader', 'aria2c',
      '--downloader-args', 'aria2c:-x 16 -s 16 -k 1M',
      '-f', `bv*[ext=mp4][height<=${safeQuality}]+ba[ext=m4a]/bv*[height<=${safeQuality}]+ba/b[ext=mp4]/b`,
      '--merge-output-format', 'mp4',
      '-o', outputTemplate,
      url
    ];

    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let mergeSeen = false;
    let etaEma = null;

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      console.log(text);
      const p = parseProgressLine(text);
      if (p) {
        const etaSeconds = parseEtaToSeconds(p.eta);
        if (etaSeconds !== null) etaEma = etaEma === null ? etaSeconds : (etaEma * 0.7 + etaSeconds * 0.3);
        setJob(jobId, {
          stage: mergeSeen ? 'processing' : 'downloading',
          status: mergeSeen ? 'Mesclando formatos...' : 'Baixando...',
          progress: Math.max(0, Math.min(99, p.percent)),
          speed: p.speed,
          eta: etaEma !== null ? formatEta(etaEma) : p.eta
        });
      }
      if (text.includes('Merging formats into') && !mergeSeen) {
        mergeSeen = true;
        setJob(jobId, { stage: 'processing', status: 'Mesclando formatos...', progress: 99, speed: '--', eta: '0:05' });
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      console.log(text);
      if (text.includes('Merging formats into') && !mergeSeen) {
        mergeSeen = true;
        setJob(jobId, { stage: 'processing', status: 'Mesclando formatos...', progress: 99, speed: '--', eta: '0:05' });
      }
    });

    child.on('error', (err) => {
      setJob(jobId, { stage: 'error', status: 'Erro', error: err.message || 'Erro ao iniciar download' });
    });

    child.on('close', async (code) => {
      try {
        if (code !== 0) {
          setJob(jobId, { stage: 'error', status: 'Erro', error: 'Falha no yt-dlp', done: false });
          return;
        }

        const finalPath = findFinalMp4(jobId);
        if (!finalPath) {
          setJob(jobId, { stage: 'error', status: 'Erro', error: 'Arquivo final não encontrado', done: false });
          return;
        }

        const stat = fs.statSync(finalPath);
        if (!stat.size || stat.size < 1024) {
          setJob(jobId, { stage: 'error', status: 'Erro', error: 'MP4 final muito pequeno', done: false });
          return;
        }

        const report = await buildReport(finalPath);
        job.report = report;
        job.reportReady = true;

        setJob(jobId, {
          stage: 'finished',
          status: 'Concluído',
          progress: 100,
          speed: '--',
          eta: '--',
          done: true,
          file: `/api/file/${jobId}`,
          reportReady: true
        });
      } catch (err) {
        console.error(err);
        setJob(jobId, { stage: 'error', status: 'Erro', error: err.message || 'Falha ao finalizar', done: false });
      }
    });
  } catch (err) {
    console.error(err);
    setJob(jobId, { stage: 'error', status: 'Erro', error: err.message || 'Erro ao processar vídeo' });
  }
}

app.post('/api/download', async (req, res) => {
  if (busy) return res.status(429).json({ error: 'Servidor ocupado' });

  const { url, quality, clientId } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL inválida' });

  const id = String(clientId || createJobId());
  if (jobs[id]) return res.status(409).json({ error: 'Job já existe' });

  jobs[id] = {
    id,
    title: 'Preparando download...',
    thumbnail: '',
    stage: 'starting',
    status: 'Preparando download...',
    progress: 0,
    speed: 'Conectando...',
    eta: '--',
    done: false,
    file: '',
    error: '',
    startedAt: now(),
    updatedAt: now(),
    reportReady: false,
    report: null
  };

  busy = true;
  res.status(202).json({ success: true, id });
  processDownload(id, url, quality).finally(() => { busy = false; });
});

app.get('/api/status/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) {
    const file = findFinalMp4(req.params.id);
    if (file) {
      return res.json({ id: req.params.id, stage: 'finished', status: 'Concluído', progress: 100, done: true, file: `/api/file/${req.params.id}`, reportReady: true });
    }
    return res.status(404).json({ error: 'Job não encontrado' });
  }
  res.json(publicJob(job));
});

app.get('/api/file/:id', (req, res) => {
  const file = findFinalMp4(req.params.id);
  if (!file) return res.status(404).send('Arquivo não encontrado');
  const fileName = path.basename(file);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', 'video/mp4');
  return fs.createReadStream(file).pipe(res);
});

app.get('/api/report/:id', async (req, res) => {
  try {
    const job = jobs[req.params.id];
    const file = findFinalMp4(req.params.id);
    if (!file) return res.status(404).json({ error: 'Arquivo final não encontrado' });
    const report = job?.report || await buildReport(file);
    if (job) {
      job.report = report;
      job.reportReady = true;
      emitJob(job);
    }
    res.json(report);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Falha ao gerar relatório' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
