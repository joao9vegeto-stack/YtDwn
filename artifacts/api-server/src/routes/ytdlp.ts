import { Router } from "express";
import { spawn, execSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import https from "https";
import http from "http";

const router = Router();

// ── Binary resolution ────────────────────────────────────────────────────────
// Pinned to 2024.12.13: last version where android_vr/android clients work on
// datacenter IPs without PO tokens or EJS n-challenge scripts.
// v2025+ requires yt-dlp-scripts (not bundled in standalone) for n-challenge,
// and android clients started requiring GVS PO tokens on cloud IPs.
const YTDLP_VERSION = "2024.12.13";
const YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux`;

const BIN_DIR = path.join(os.tmpdir(), "yt-dlp-server");
const STANDALONE_BIN = path.join(BIN_DIR, "yt-dlp");

let YTDLP_BIN = STANDALONE_BIN;

async function ensureBinary(): Promise<void> {
  try {
    const stat = fs.existsSync(YTDLP_BIN) ? fs.statSync(YTDLP_BIN) : null;
    if (stat && stat.size > 1_000_000) {
      // Verify pinned version is installed (re-download if stale/wrong version)
      try {
        const ver = execSync(`${YTDLP_BIN} --version 2>/dev/null`).toString().trim();
        if (ver === YTDLP_VERSION) {
          console.log(`[setup-ytdlp] Binário OK v${ver} — ${YTDLP_BIN}`);
          return;
        }
        console.log(`[setup-ytdlp] Versão incorreta: ${ver} (esperado ${YTDLP_VERSION}), re-baixando…`);
      } catch (_) {
        console.log(`[setup-ytdlp] Binário OK (${(stat.size / 1e6).toFixed(0)} MB) — ${YTDLP_BIN}`);
        return;
      }
    }
    console.log(`[setup-ytdlp] Baixando yt-dlp v${YTDLP_VERSION}…`);
    fs.mkdirSync(BIN_DIR, { recursive: true });
    await downloadFile(YTDLP_URL, STANDALONE_BIN);
    fs.chmodSync(STANDALONE_BIN, 0o755);
    console.log(`[setup-ytdlp] Download OK v${YTDLP_VERSION} — ${STANDALONE_BIN}`);
  } catch (e) {
    console.error("[setup-ytdlp] Falha ao garantir binário:", e);
  }
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (u: string, redirects = 0) => {
      if (redirects > 10) { reject(new Error("Too many redirects")); return; }
      const mod = u.startsWith("https") ? https : http;
      (mod as typeof https).get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          follow(res.headers.location!, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        const f = fs.createWriteStream(dest);
        res.pipe(f);
        f.on("finish", () => f.close(() => resolve()));
        f.on("error", (e) => { fs.unlink(dest, () => {}); reject(e); });
      }).on("error", reject);
    };
    follow(url);
  });
}

// ── ffmpeg & Node shim ────────────────────────────────────────────────────────
const FFMPEG_BIN = (() => {
  try {
    return execSync("which ffmpeg 2>/dev/null || echo ffmpeg").toString().trim();
  } catch (_) {
    return "ffmpeg";
  }
})();

const NODE_SHIM_DIR = path.join(os.tmpdir(), "ytdlp_nodebin");
(function setupNodeShim() {
  try {
    fs.mkdirSync(NODE_SHIM_DIR, { recursive: true });
    // Prefer `which node` (the Nix wrapper script) over process.execPath (raw binary).
    // The Nix wrapper sets LD_LIBRARY_PATH so shared libs resolve correctly when
    // yt-dlp's embedded Python spawns node as a subprocess for n-challenge solving.
    let nodeExec = process.execPath;
    try {
      const found = execSync("which node 2>/dev/null || true", { env: process.env })
        .toString().trim();
      if (found && fs.existsSync(found)) nodeExec = found;
    } catch (_) {}
    // Shell script wrapper is more portable than a symlink across environments
    const shimPath = path.join(NODE_SHIM_DIR, "node");
    try { fs.unlinkSync(shimPath); } catch (_) {}  // remove old symlink if exists
    fs.writeFileSync(shimPath, `#!/bin/sh\nexec '${nodeExec.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o755 });
    console.log(`[setup-ytdlp] node wrapper → ${nodeExec}`);
  } catch (e) {
    console.warn("[setup-ytdlp] node shim failed:", e);
  }
})();

function spawnEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: [NODE_SHIM_DIR, process.env["PATH"] || ""].join(":") };
}

// ── Replit KV DB for persistent cookies ──────────────────────────────────────
const REPLIT_DB_URL = process.env["REPLIT_DB_URL"];
const COOKIES_KEY = "yt_cookies_v1";

async function dbGet(key: string): Promise<string | null> {
  if (!REPLIT_DB_URL) return null;
  try {
    const res = await fetch(`${REPLIT_DB_URL}/${encodeURIComponent(key)}`);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const text = await res.text();
    return decodeURIComponent(text);
  } catch (_) { return null; }
}

async function dbSet(key: string, value: string): Promise<void> {
  if (!REPLIT_DB_URL) return;
  try {
    await fetch(REPLIT_DB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    });
  } catch (_) {}
}

async function dbDelete(key: string): Promise<void> {
  if (!REPLIT_DB_URL) return;
  try {
    await fetch(`${REPLIT_DB_URL}/${encodeURIComponent(key)}`, { method: "DELETE" });
  } catch (_) {}
}

// ── Cookies file ──────────────────────────────────────────────────────────────
const COOKIES_FILE = path.join(os.tmpdir(), "yt_cookies.txt");

function hasCookies(): boolean {
  try {
    return fs.existsSync(COOKIES_FILE) && fs.statSync(COOKIES_FILE).size > 100;
  } catch (_) { return false; }
}

function sanitizeCookies(raw: string): string {
  const lines = raw.trim().split(/\r?\n/);
  const out: string[] = [];

  // Ensure valid Netscape header
  const firstValid = lines.find((l) => l.startsWith("#") || l.includes("\t"));
  if (!firstValid || !lines[0].startsWith("# Netscape")) {
    out.push("# Netscape HTTP Cookie File");
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) {
      // Keep comments, but skip non-standard headers like "Cookies 3.0"
      if (/^#\s*(Netscape|HttpOnly|http)/i.test(trimmed) || trimmed.startsWith("# ")) {
        out.push(line);
      }
      continue;
    }
    // Cookie entry must have exactly 7 tab-separated fields
    const fields = trimmed.split("\t");
    if (fields.length === 7) {
      out.push(line);
    }
    // Otherwise skip malformed lines silently
  }

  return out.join("\n") + "\n";
}

async function persistCookies(content: string): Promise<void> {
  const sanitized = sanitizeCookies(content);
  fs.writeFileSync(COOKIES_FILE, sanitized, "utf8");
  await dbSet(COOKIES_KEY, sanitized);
  console.log(`[cookies] Salvo — ${sanitized.split("\n").filter(l => l && !l.startsWith("#")).length} entradas (${(sanitized.length / 1024).toFixed(1)} KB)`);
}

async function removeCookies(): Promise<void> {
  try { fs.unlinkSync(COOKIES_FILE); } catch (_) {}
  await dbDelete(COOKIES_KEY);
  console.log("[cookies] Removido do arquivo e do DB");
}

async function loadCookiesFromDB(): Promise<void> {
  if (hasCookies()) return;
  const value = await dbGet(COOKIES_KEY);
  if (value && value.length > 100) {
    const sanitized = sanitizeCookies(value);
    fs.writeFileSync(COOKIES_FILE, sanitized, "utf8");
    console.log(`[cookies] Restaurado do DB (${(sanitized.length / 1024).toFixed(1)} KB)`);
  }
}

// ── OAuth2 support ────────────────────────────────────────────────────────────
// OAuth2 device flow bypasses ALL YouTube IP restrictions.
// Works from datacenter IPs — no PO Token requirement, no android client blocks.
// Uses Google's official server-side OAuth2 API (explicitly supported for servers).
const OAUTH2_CACHE_DIR = path.join(os.tmpdir(), "yt-dlp-oauth2");
const OAUTH2_DB_KEY = "yt_oauth2_v2";

interface OAuth2State {
  status: "idle" | "pending" | "complete" | "error";
  deviceUrl?: string;
  userCode?: string;
}
let oauth2State: OAuth2State = { status: "idle" };
let oauth2Proc: ReturnType<typeof spawn> | null = null;

function hasOAuth2Token(): boolean {
  try {
    const dir = path.join(OAUTH2_CACHE_DIR, "youtube");
    return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith(".json"));
  } catch (_) { return false; }
}

async function saveOAuth2Token(): Promise<void> {
  const dir = path.join(OAUTH2_CACHE_DIR, "youtube");
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (!files.length) return;
  const data: Record<string, string> = {};
  for (const f of files) data[f] = fs.readFileSync(path.join(dir, f), "utf8");
  await dbSet(OAUTH2_DB_KEY, JSON.stringify(data));
  console.log("[oauth2] Token salvo no DB");
}

async function restoreOAuth2Token(): Promise<void> {
  const raw = await dbGet(OAUTH2_DB_KEY);
  if (!raw) return;
  try {
    const data = JSON.parse(raw) as Record<string, string>;
    const dir = path.join(OAUTH2_CACHE_DIR, "youtube");
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, content] of Object.entries(data)) fs.writeFileSync(path.join(dir, f), content);
    oauth2State = { status: "complete" };
    console.log("[oauth2] Token restaurado do DB");
  } catch (e) {
    console.warn("[oauth2] Falha ao restaurar:", e);
  }
}

async function removeOAuth2Token(): Promise<void> {
  const dir = path.join(OAUTH2_CACHE_DIR, "youtube");
  try {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} }
    }
  } catch (_) {}
  await dbDelete(OAUTH2_DB_KEY);
  oauth2State = { status: "idle" };
  console.log("[oauth2] Token removido");
}

// ── Config ────────────────────────────────────────────────────────────────────
const TIERS = [1080, 720];

interface Job {
  status: "downloading" | "encoding" | "ready" | "error";
  message: string;
  progress: number;
  eta: string | null;
  rawFile?: string;
  outFile?: string;
  safeFilename?: string;
  sizeMB?: string;
  proc?: ReturnType<typeof spawn>;
  thumbnail?: string;
  title?: string;
  createdAt: number;
}

const jobs: Record<string, Job> = {};

// ── Startup ───────────────────────────────────────────────────────────────────
(async () => {
  await ensureBinary();
  await loadCookiesFromDB();
  await restoreOAuth2Token();

  console.log(`[setup-ytdlp] node shim dir: ${NODE_SHIM_DIR}`);
  console.log(`[setup-ytdlp] ffmpeg: ${FFMPEG_BIN}`);
  console.log(`[setup-ytdlp] cookies: ${hasCookies() ? "configurado" : "não configurado"}`);
  console.log(`[setup-ytdlp] oauth2: ${hasOAuth2Token() ? "configurado" : "não configurado"}`);

  // Clean leftover temp files from previous runs
  try {
    fs.readdirSync(os.tmpdir())
      .filter((f: string) => f.startsWith("ytdl_"))
      .forEach((f: string) => {
        try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (_) {}
      });
  } catch (_) {}

  // Skip auto-update: the standalone binary self-updates in place which can
  // temporarily corrupt the binary mid-request on cold starts.
})();

// Auto-clean old jobs
setInterval(() => {
  const now = Date.now();
  Object.keys(jobs).forEach((id) => {
    const j = jobs[id];
    const age = now - j.createdAt;
    if (j.status === "ready" && age > 4 * 60 * 60 * 1000) cleanJob(id);
    if (j.status !== "ready" && age > 20 * 60 * 1000) cleanJob(id);
  });
}, 2 * 60 * 1000);

// ── Helpers ───────────────────────────────────────────────────────────────────
function hmsToSec(hms: string): number {
  if (!hms) return 0;
  const parts = hms.split(":").map(parseFloat);
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function fmtEta(secs: number | null): string | null {
  if (!secs || secs <= 0) return null;
  if (secs < 60) return `~${Math.round(secs)}s restantes`;
  return `~${Math.round(secs / 60)}min restantes`;
}

function cleanJob(id: string) {
  const job = jobs[id];
  if (!job) return;
  try { if (job.proc) job.proc.kill("SIGKILL"); } catch (_) {}
  try { if (job.rawFile) fs.unlinkSync(job.rawFile); } catch (_) {}
  try { if (job.rawFile) fs.unlinkSync(job.rawFile + ".part"); } catch (_) {}
  try { if (job.outFile) fs.unlinkSync(job.outFile); } catch (_) {}
  delete jobs[id];
}

// ── Client strategy ───────────────────────────────────────────────────────────
//
// Binary pinned to v2024.12.13 — this version is critical for the strategy:
//
// Tier 1 — android_vr,android (NO cookies):
//   These clients work on datacenter/cloud IPs without PO tokens or n-challenge.
//   In v2025+, YouTube started requiring GVS PO tokens for android clients on cloud
//   IPs — v2024.12.13 predates this restriction. Never pass cookies here: yt-dlp
//   silently skips android clients when a cookies file is present.
//
// Tier 2 — web + cookies:
//   For age-restricted or login-required content. The web client is the only one
//   that supports cookies AND is not blocked on cloud IPs. n-challenge may be
//   attempted via the node shim (wrapped Nix binary with correct LD_LIBRARY_PATH).
//
// Tier 3 — web (no cookies, last resort):
//   Same as Tier 2 but without cookies, in case cookies caused a rejection.

function tier1Args(): string[] {
  return [
    "--no-playlist",
    "--extractor-args", "youtube:player_client=android_vr,android",
  ];
}

function tier2Args(): string[] {
  const args = [
    "--no-playlist",
    "--extractor-args", "youtube:player_client=web",
  ];
  if (hasCookies()) args.push("--cookies", COOKIES_FILE);
  return args;
}

function tier3Args(): string[] {
  return [
    "--no-playlist",
    "--extractor-args", "youtube:player_client=web",
  ];
}

// ── spawnJson helper ──────────────────────────────────────────────────────────
function spawnJson(args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let out = "";
    let errOut = "";
    const proc = spawn(YTDLP_BIN, args, { env: spawnEnv() });
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { errOut += d.toString(); });
    proc.on("error", (e: Error) => reject(new Error("yt-dlp não encontrado: " + e.message)));
    proc.on("close", (code: number) => {
      if (code !== 0) {
        const msg = errOut
          .split("\n")
          .filter((l) => l.trim() && !l.startsWith("[debug]"))
          .slice(-6)
          .join(" | ")
          .slice(-800) || "yt-dlp falhou";
        reject(new Error(msg));
        return;
      }
      try { resolve(JSON.parse(out)); }
      catch (_) { reject(new Error("Resposta inválida do yt-dlp")); }
    });
  });
}

function hasVideoFormats(info: Record<string, unknown>): boolean {
  const fmts = info["formats"] as Array<{ vcodec?: string; height?: number }> | undefined;
  return Array.isArray(fmts) && fmts.some((f) => f.vcodec && f.vcodec !== "none" && (f.height ?? 0) > 0);
}

async function fetchVideoJson(url: string): Promise<Record<string, unknown>> {
  // Tier 0 — OAuth2 (web client + OAuth2 token):
  //   Works from ANY IP including Replit datacenter. No PO Token required.
  //   Google's OAuth2 explicitly supports server-side use.
  if (hasOAuth2Token()) {
    try {
      const result = await spawnJson([
        "--dump-single-json", "--no-playlist",
        "--extractor-args", "youtube:player_client=web",
        "--username", "oauth2", "--password", "",
        "--cache-dir", OAUTH2_CACHE_DIR,
        url,
      ]);
      if (hasVideoFormats(result)) {
        console.log("[yt-dlp] Tier OAuth2 OK");
        return result;
      }
      console.log("[yt-dlp] OAuth2 sem formatos, tentando Tier 1…");
    } catch (e0) {
      console.log(`[yt-dlp] OAuth2 falhou: ${(e0 as Error).message?.slice(0, 200)}, tentando Tier 1…`);
    }
  }

  // Tier 1: android_vr,android — no n-challenge, but blocked on Replit prod IPs
  try {
    const result = await spawnJson(["--dump-single-json", ...tier1Args(), url]);
    if (hasVideoFormats(result)) {
      console.log("[yt-dlp] Tier 1 OK");
      return result;
    }
    console.log("[yt-dlp] Tier 1 sem formatos de vídeo, tentando Tier 2…");
  } catch (e1) {
    console.log(`[yt-dlp] Tier 1 falhou: ${(e1 as Error).message?.slice(0, 200)}\n→ tentando Tier 2…`);
  }

  // Tier 2: web + cookies
  try {
    const result = await spawnJson(["--dump-single-json", ...tier2Args(), url]);
    if (hasVideoFormats(result)) {
      console.log("[yt-dlp] Tier 2 OK");
      return result;
    }
    console.log("[yt-dlp] Tier 2 sem formatos de vídeo, tentando Tier 3…");
  } catch (e2) {
    console.log(`[yt-dlp] Tier 2 falhou: ${(e2 as Error).message?.slice(0, 200)}\n→ tentando Tier 3…`);
  }

  // Tier 3: web only — last resort
  console.log("[yt-dlp] Tentando Tier 3 (web)…");
  return spawnJson(["--dump-single-json", ...tier3Args(), url]);
}

// ── POST /api/cookies ─────────────────────────────────────────────────────────
router.post("/cookies", async (req, res) => {
  const { content } = req.body as { content?: string };
  if (!content || content.trim().length < 50)
    return res.status(400).json({ error: "Conteúdo de cookies inválido" });
  try {
    await persistCookies(content);
    res.json({ ok: true });
  } catch (_) {
    res.status(500).json({ error: "Erro ao salvar cookies" });
  }
});

// ── DELETE /api/cookies ───────────────────────────────────────────────────────
router.delete("/cookies", async (_req, res) => {
  try {
    await removeCookies();
    res.json({ ok: true });
  } catch (_) {
    res.status(500).json({ error: "Erro ao remover cookies" });
  }
});

// ── GET /api/cookies-status ───────────────────────────────────────────────────
router.get("/cookies-status", (_req, res) => {
  res.json({ configured: hasCookies() });
});

// ── GET /api/oauth2/status ────────────────────────────────────────────────────
router.get("/oauth2/status", (_req, res) => {
  res.json({
    connected: hasOAuth2Token(),
    status: hasOAuth2Token() ? "complete" : oauth2State.status,
    deviceUrl: oauth2State.deviceUrl,
    userCode: oauth2State.userCode,
  });
});

// ── POST /api/oauth2/start ────────────────────────────────────────────────────
router.post("/oauth2/start", async (_req, res) => {
  if (hasOAuth2Token()) return res.json({ status: "complete" });
  if (oauth2State.status === "pending" && oauth2State.deviceUrl) {
    return res.json({ status: "pending", deviceUrl: oauth2State.deviceUrl, userCode: oauth2State.userCode });
  }

  await ensureBinary();
  if (oauth2Proc) { try { oauth2Proc.kill("SIGKILL"); } catch (_) {} oauth2Proc = null; }
  oauth2State = { status: "pending" };

  // Use --dump-single-json with a public video so yt-dlp completes after auth
  const proc = spawn(YTDLP_BIN, [
    "--username", "oauth2", "--password", "",
    "--cache-dir", OAUTH2_CACHE_DIR,
    "--no-playlist",
    "--dump-single-json",
    "https://youtu.be/dQw4w9WgXcQ",
  ], { env: spawnEnv() });
  oauth2Proc = proc;

  const onData = (d: Buffer) => {
    const text = d.toString();
    if (text.trim()) console.log("[oauth2]", text.trim().slice(0, 300));
    // Capture device URL — try multiple yt-dlp output formats
    if (!oauth2State.deviceUrl) {
      const urlM = text.match(/(https:\/\/(?:www\.)?google\.com\/device[^\s"']*)/i)
                || text.match(/(https:\/\/accounts\.google\.com\/o\/oauth2\/device[^\s"']*)/i);
      if (urlM) oauth2State.deviceUrl = urlM[1];
    }
    if (!oauth2State.userCode) {
      const codeM = text.match(/code[:\s]+([A-Z0-9]{4}-[A-Z0-9]{4})/i)
                 || text.match(/enter[^:]*:\s*([A-Z0-9]{4,16})/i);
      if (codeM) oauth2State.userCode = codeM[1];
    }
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);

  proc.on("close", async (code) => {
    oauth2Proc = null;
    if (code === 0 && hasOAuth2Token()) {
      oauth2State.status = "complete";
      await saveOAuth2Token();
      console.log("[oauth2] Autenticação concluída com sucesso");
    } else if (oauth2State.status === "pending") {
      oauth2State = { ...oauth2State, status: "error" };
      console.log("[oauth2] Processo encerrou com código", code);
    }
  });

  // Wait up to 20 s for device URL to appear before responding
  await new Promise<void>((resolve) => {
    const deadline = Date.now() + 20_000;
    const t = setInterval(() => {
      if (oauth2State.deviceUrl || Date.now() > deadline) { clearInterval(t); resolve(); }
    }, 400);
  });

  res.json({ status: oauth2State.status, deviceUrl: oauth2State.deviceUrl, userCode: oauth2State.userCode });
});

// ── GET /api/oauth2/poll ──────────────────────────────────────────────────────
router.get("/oauth2/poll", (_req, res) => {
  res.json({
    status: hasOAuth2Token() ? "complete" : oauth2State.status,
    deviceUrl: oauth2State.deviceUrl,
    userCode: oauth2State.userCode,
  });
});

// ── DELETE /api/oauth2 ────────────────────────────────────────────────────────
router.delete("/oauth2", async (_req, res) => {
  if (oauth2Proc) { try { oauth2Proc.kill("SIGKILL"); } catch (_) {} oauth2Proc = null; }
  await removeOAuth2Token();
  res.json({ ok: true });
});

// ── POST /api/video ───────────────────────────────────────────────────────────
router.post("/video", async (req, res) => {
  try {
    const { url } = req.body as { url?: string };
    if (!url) return res.status(400).json({ error: "URL obrigatória" });

    await ensureBinary();
    const info = await fetchVideoJson(url);

    const videoFormats = (
      info["formats"] as Array<{ vcodec?: string; height?: number }>
    ).filter((f) => f.vcodec && f.vcodec !== "none" && f.height);

    const baseName = ((info["title"] as string) || "video")
      .replace(/[^a-z0-9áéíóúâêîôûãõ\s_-]/gi, "_")
      .replace(/\s+/g, "_")
      .slice(0, 80);

    const qualities: Array<{ height: number; codec: string; filename: string }> = [];

    for (const tier of TIERS) {
      if (videoFormats.some((f) => (f.height ?? 0) >= tier * 0.94)) {
        qualities.push({
          height: tier,
          codec: "h264",
          filename: `${baseName}_${tier}p_H264.mp4`,
        });
      }
    }

    if (qualities.length === 0 && videoFormats.length > 0) {
      const maxHeight = Math.max(...videoFormats.map((f) => f.height ?? 0));
      if (maxHeight > 0) {
        qualities.push({
          height: maxHeight,
          codec: "h264",
          filename: `${baseName}_${maxHeight}p_H264.mp4`,
        });
      }
    }

    res.json({
      title: info["title"],
      thumbnail: info["thumbnail"],
      videoUrl: url,
      qualities,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[/api/video] erro:", msg.slice(0, 200));
    res.status(500).json({ error: "Erro ao buscar vídeo: " + msg });
  }
});

// ── POST /api/prepare ─────────────────────────────────────────────────────────
router.post("/prepare", (req, res) => {
  const { url, height, filename, thumbnail, title } = req.body as {
    url?: string;
    height?: number;
    codec?: string;
    filename?: string;
    thumbnail?: string;
    title?: string;
  };
  if (!url || !height)
    return res.status(400).json({ error: "Parâmetros inválidos" });

  const id = String(Date.now());
  const safeFilename = (filename || `video_${height}p.mp4`).replace(/[^a-z0-9._-]/gi, "_");
  const rawFile = path.join(os.tmpdir(), `ytdl_raw_${id}`);
  const outFile = path.join(os.tmpdir(), `ytdl_out_${id}.mp4`);

  jobs[id] = {
    status: "downloading",
    message: "Baixando vídeo…",
    progress: 0,
    eta: null,
    rawFile,
    outFile,
    safeFilename,
    thumbnail,
    title,
    createdAt: Date.now(),
  };
  res.json({ jobId: id });

  const formatStr = [
    `bestvideo[height<=${height}][vcodec^=avc1]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${height}][vcodec^=avc]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${height}]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${height}]+bestaudio`,
    `best[height<=${height}]`,
    "best",
  ].join("/");

  // Use OAuth2 client (web) if token is available, otherwise fall back to android_vr,android
  const dlClientArgs = hasOAuth2Token()
    ? [
        "--no-playlist",
        "--extractor-args", "youtube:player_client=web",
        "--username", "oauth2", "--password", "",
        "--cache-dir", OAUTH2_CACHE_DIR,
      ]
    : tier1Args();

  const dlArgs = [
    "-f", formatStr,
    "--merge-output-format", "mp4",
    "--newline",
    "--progress",
    "--no-part",
    "--retries", "5",
    "--fragment-retries", "5",
    "-o", rawFile + ".%(ext)s",
    ...dlClientArgs,
    url,
  ];

  console.log(`[${id}] ${height}p starting`);
  const dl = spawn(YTDLP_BIN, dlArgs, { env: spawnEnv() });
  jobs[id].proc = dl;

  const dlTimeout = setTimeout(() => {
    dl.kill("SIGKILL");
    if (jobs[id]) Object.assign(jobs[id], { status: "error", message: "Download expirou (15min)" });
  }, 15 * 60 * 1000);

  let dlBuf = "";
  let detectedExt = "mp4";

  const parseDl = (chunk: Buffer) => {
    dlBuf += chunk.toString();
    const lines = dlBuf.split(/[\r\n]/);
    dlBuf = lines.pop() ?? "";
    for (const line of lines) {
      // Detect actual output extension
      const destM = line.match(/\[download\] Destination: .+\.(\w{2,4})$/);
      if (destM) detectedExt = destM[1];

      const pctM = line.match(/\[download\]\s+([\d.]+)%/);
      const rateM = line.match(/at\s+([\d.]+\s*[KMGk]iB\/s)/);
      const etaM = line.match(/ETA\s+(\d+:\d+)/);
      if (pctM && jobs[id] && jobs[id].status === "downloading") {
        const dlPct = parseFloat(pctM[1]);
        jobs[id].progress = Math.round(dlPct * 0.4);
        const rate = rateM ? ` · ${rateM[1]}` : "";
        const eta = etaM ? ` · ETA ${etaM[1]}` : "";
        jobs[id].message = `Baixando… ${dlPct.toFixed(1)}%${rate}${eta}`;
      }
    }
  };

  dl.stdout.on("data", parseDl);
  dl.stderr.on("data", parseDl);

  dl.on("close", (code: number) => {
    clearTimeout(dlTimeout);
    if (!jobs[id]) return;

    // Find the actual downloaded file (yt-dlp appends ext)
    let actualRaw = rawFile + ".mp4";
    for (const ext of [detectedExt, "mp4", "mkv", "webm"]) {
      const candidate = rawFile + "." + ext;
      if (fs.existsSync(candidate) && fs.statSync(candidate).size > 10_000) {
        actualRaw = candidate;
        break;
      }
    }

    if (code !== 0 || !fs.existsSync(actualRaw) || fs.statSync(actualRaw).size < 10_000) {
      Object.assign(jobs[id], { status: "error", message: `Falha no download (código ${code})` });
      return;
    }

    // Validate raw file isn't suspiciously small (truncation guard)
    const rawSizeMB = fs.statSync(actualRaw).size / 1024 / 1024;
    console.log(`[${id}] Raw file: ${rawSizeMB.toFixed(1)} MB`);

    Object.assign(jobs[id], { status: "encoding", message: "Convertendo para H264…", progress: 40 });
    jobs[id].rawFile = actualRaw;

    const ffArgs = [
      "-y", "-threads", "0", "-i", actualRaw,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-profile:v", "high",
      "-level", "4.2",
      "-pix_fmt", "yuv420p",
      "-vf", "fps=30",
      "-g", "60",
      "-keyint_min", "60",
      "-sc_threshold", "0",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      outFile,
    ];

    const ff = spawn(FFMPEG_BIN, ffArgs, { env: spawnEnv() });
    jobs[id].proc = ff;

    let totalSec = 0;
    const encodeStart = Date.now();
    let lastPct = 40;

    ff.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (!totalSec) {
        const dm = text.match(/Duration:\s*(\d+:\d+:\d+\.\d+)/);
        if (dm) totalSec = hmsToSec(dm[1]);
      }
      const tm = text.match(/time=(\d+:\d+:\d+\.\d+)/);
      if (tm && totalSec > 0) {
        const doneSec = hmsToSec(tm[1]);
        const pct = Math.min(95, 40 + Math.round((doneSec / totalSec) * 55));
        const elapsed = (Date.now() - encodeStart) / 1000;
        const rate = doneSec / elapsed;
        const remaining = rate > 0 ? (totalSec - doneSec) / rate : null;
        if (pct > lastPct) {
          lastPct = pct;
          if (jobs[id]) {
            jobs[id].progress = pct;
            jobs[id].eta = fmtEta(remaining);
            jobs[id].message = `H264 ${pct}%${remaining ? " — " + fmtEta(remaining) : ""}`;
          }
        }
      }
    });

    ff.on("close", (code2: number) => {
      try { fs.unlinkSync(actualRaw); } catch (_) {}
      if (!jobs[id]) return;
      if (code2 !== 0 || !fs.existsSync(outFile)) {
        Object.assign(jobs[id], { status: "error", message: `Falha na conversão H264 (código ${code2})` });
        return;
      }
      const size = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
      console.log(`[${id}] Pronto: ${size} MB`);
      Object.assign(jobs[id], { status: "ready", progress: 100, message: `Pronto — ${size} MB`, eta: null, sizeMB: size });
    });

    ff.on("error", (err: Error) => {
      if (jobs[id])
        Object.assign(jobs[id], { status: "error", message: "ffmpeg não encontrado: " + err.message });
    });
  });

  dl.on("error", (err: Error) => {
    if (jobs[id])
      Object.assign(jobs[id], { status: "error", message: "Falha ao iniciar yt-dlp: " + err.message });
  });
});

// ── GET /api/status ───────────────────────────────────────────────────────────
router.get("/status", (req, res) => {
  const job = jobs[req.query["id"] as string];
  if (!job) return res.status(404).json({ error: "Job não encontrado ou expirado" });
  res.json({
    status: job.status,
    message: job.message,
    progress: job.progress || 0,
    eta: job.eta,
    sizeMB: job.sizeMB || null,
    thumbnail: job.thumbnail || null,
    title: job.title || null,
  });
});

// ── GET /api/queue ────────────────────────────────────────────────────────────
router.get("/queue", (_req, res) => {
  const list = Object.entries(jobs).map(([id, job]) => ({
    id,
    status: job.status,
    message: job.message,
    progress: job.progress || 0,
    eta: job.eta,
    sizeMB: job.sizeMB || null,
    thumbnail: job.thumbnail || null,
    title: job.title || null,
    safeFilename: job.safeFilename || null,
    createdAt: job.createdAt,
  }));
  res.json({ jobs: list });
});

// ── GET /api/file ─────────────────────────────────────────────────────────────
router.get("/file", (req, res) => {
  const { id } = req.query as { id?: string };
  const job = jobs[id as string];
  if (!job || job.status !== "ready")
    return res.status(404).json({ error: "Arquivo não disponível" });
  if (!job.outFile || !fs.existsSync(job.outFile))
    return res.status(410).json({ error: "Arquivo expirado" });

  const filePath = job.outFile;
  const fileStat = fs.statSync(filePath);
  const fileSize = fileStat.size;
  const range = req.headers["range"];

  res.setHeader("Content-Disposition", `attachment; filename="${job.safeFilename}"`);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    res.setHeader("Content-Length", chunkSize);
    res.status(206);
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.setHeader("Content-Length", fileSize);
    fs.createReadStream(filePath).pipe(res);
  }
});

// ── DELETE /api/cancel ────────────────────────────────────────────────────────
router.delete("/cancel", (req, res) => {
  const { id } = req.query as { id?: string };
  const job = jobs[id as string];
  if (!job) return res.status(404).json({ error: "Job não encontrado" });
  cleanJob(id as string);
  res.json({ ok: true });
});

export default router;
