const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API = `${BASE}/api`;

export interface VideoQuality {
  height: number;
  codec: string;
  filename: string;
}

export interface VideoInfo {
  title: string;
  thumbnail: string;
  videoUrl: string;
  qualities: VideoQuality[];
}

export interface JobStatus {
  id: string;
  status: "downloading" | "encoding" | "ready" | "error";
  message: string;
  progress: number;
  eta: string | null;
  sizeMB: string | null;
  thumbnail: string | null;
  title: string | null;
  safeFilename: string | null;
  createdAt: number;
}

export interface OAuth2Status {
  connected: boolean;
  status: "idle" | "pending" | "complete" | "error";
  deviceUrl?: string;
  userCode?: string;
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, opts);
  if (!res.ok) {
    let errMsg = "Erro desconhecido";
    try {
      const data = await res.json();
      errMsg = data.error || errMsg;
    } catch (_) {}
    throw new Error(errMsg);
  }
  return res.json() as Promise<T>;
}

export async function fetchVideoInfo(url: string): Promise<VideoInfo> {
  return apiFetch<VideoInfo>("/video", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

export async function prepareDownload(params: {
  url: string;
  height: number;
  codec: string;
  filename: string;
  thumbnail?: string;
  title?: string;
}): Promise<{ jobId: string }> {
  return apiFetch<{ jobId: string }>("/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

export async function getJobStatus(id: string): Promise<JobStatus> {
  return apiFetch<JobStatus>(`/status?id=${encodeURIComponent(id)}`);
}

export async function getQueue(): Promise<{ jobs: JobStatus[] }> {
  return apiFetch<{ jobs: JobStatus[] }>("/queue");
}

export async function cancelJob(id: string): Promise<void> {
  await fetch(`${API}/cancel?id=${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getFileUrl(id: string): string {
  return `${API}/file?id=${encodeURIComponent(id)}`;
}

export async function getCookiesStatus(): Promise<{ configured: boolean }> {
  return apiFetch<{ configured: boolean }>("/cookies-status");
}

export async function saveCookies(content: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("/cookies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

export async function deleteCookies(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("/cookies", { method: "DELETE" });
}

export async function getOAuth2Status(): Promise<OAuth2Status> {
  return apiFetch<OAuth2Status>("/oauth2/status");
}

export async function startOAuth2(): Promise<OAuth2Status> {
  return apiFetch<OAuth2Status>("/oauth2/start", { method: "POST" });
}

export async function pollOAuth2(): Promise<OAuth2Status> {
  return apiFetch<OAuth2Status>("/oauth2/poll");
}

export async function removeOAuth2(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("/oauth2", { method: "DELETE" });
}
