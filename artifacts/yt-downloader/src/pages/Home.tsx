import { useState, useEffect, useRef, useCallback } from "react";
import {
  fetchVideoInfo,
  prepareDownload,
  getQueue,
  cancelJob,
  getCookiesStatus,
  deleteCookies,
  getOAuth2Status,
  startOAuth2,
  pollOAuth2,
  removeOAuth2,
  VideoInfo,
  JobStatus,
  OAuth2Status,
} from "@/lib/api";
import QueueItem from "@/components/QueueItem";
import CookiesModal from "@/components/CookiesModal";

export default function Home() {
  const [url, setUrl] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);

  const [queue, setQueue] = useState<JobStatus[]>([]);
  const [cookiesConfigured, setCookiesConfigured] = useState(false);
  const [showCookies, setShowCookies] = useState(false);
  const [removingCookies, setRemovingCookies] = useState(false);

  // OAuth2 state
  const [oauth2, setOAuth2] = useState<OAuth2Status>({ connected: false, status: "idle" });
  const [oauth2Loading, setOAuth2Loading] = useState(false);
  const [oauth2Error, setOAuth2Error] = useState<string | null>(null);
  const oauth2PollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    getCookiesStatus().then((s) => setCookiesConfigured(s.configured));
    getOAuth2Status().then((s) => setOAuth2(s));
    refreshQueue();
  }, []);

  // Poll OAuth2 when pending
  useEffect(() => {
    if (oauth2.status === "pending") {
      if (!oauth2PollRef.current) {
        oauth2PollRef.current = setInterval(async () => {
          try {
            const s = await pollOAuth2();
            setOAuth2(s);
            if (s.status === "complete" || s.status === "error") {
              clearInterval(oauth2PollRef.current!);
              oauth2PollRef.current = null;
            }
          } catch (_) {}
        }, 3000);
      }
    } else {
      if (oauth2PollRef.current) {
        clearInterval(oauth2PollRef.current);
        oauth2PollRef.current = null;
      }
    }
    return () => {
      if (oauth2PollRef.current) {
        clearInterval(oauth2PollRef.current);
        oauth2PollRef.current = null;
      }
    };
  }, [oauth2.status]);

  const refreshQueue = useCallback(async () => {
    try {
      const { jobs } = await getQueue();
      setQueue(jobs.sort((a, b) => b.createdAt - a.createdAt));
    } catch (_) {}
  }, []);

  useEffect(() => {
    const hasActive = queue.some(
      (j) => j.status === "downloading" || j.status === "encoding"
    );
    if (hasActive) {
      if (!pollingRef.current) {
        pollingRef.current = setInterval(refreshQueue, 1200);
      }
    } else {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    }
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [queue, refreshQueue]);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setSearching(true);
    setSearchError(null);
    setVideoInfo(null);
    try {
      const info = await fetchVideoInfo(url.trim());
      setVideoInfo(info);
    } catch (e: unknown) {
      setSearchError(e instanceof Error ? e.message : "Erro ao buscar vídeo");
    } finally {
      setSearching(false);
    }
  }

  async function handleDownload(quality: { height: number; codec: string; filename: string }) {
    if (!videoInfo) return;
    try {
      await prepareDownload({
        url: videoInfo.videoUrl,
        height: quality.height,
        codec: quality.codec,
        filename: quality.filename,
        thumbnail: videoInfo.thumbnail,
        title: videoInfo.title,
      });
      await refreshQueue();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Erro ao iniciar download");
    }
  }

  async function handleCancel(id: string) {
    await cancelJob(id);
    await refreshQueue();
  }

  async function handleRemoveCookies() {
    if (!confirm("Remover os cookies salvos?")) return;
    setRemovingCookies(true);
    try {
      await deleteCookies();
      setCookiesConfigured(false);
    } catch (_) {
      alert("Erro ao remover cookies.");
    } finally {
      setRemovingCookies(false);
    }
  }

  async function handleConnectOAuth2() {
    setOAuth2Loading(true);
    setOAuth2Error(null);
    try {
      const s = await startOAuth2();
      setOAuth2(s);
      if (s.status === "error") setOAuth2Error("Falha ao iniciar autenticação. Tente novamente.");
    } catch (e: unknown) {
      setOAuth2Error(e instanceof Error ? e.message : "Erro ao conectar");
      setOAuth2({ connected: false, status: "error" });
    } finally {
      setOAuth2Loading(false);
    }
  }

  async function handleDisconnectOAuth2() {
    if (!confirm("Desconectar do YouTube? Será necessário autenticar novamente.")) return;
    try {
      await removeOAuth2();
      setOAuth2({ connected: false, status: "idle" });
    } catch (_) {
      alert("Erro ao desconectar.");
    }
  }

  function handleCancelOAuth2() {
    if (oauth2PollRef.current) { clearInterval(oauth2PollRef.current); oauth2PollRef.current = null; }
    removeOAuth2().catch(() => {});
    setOAuth2({ connected: false, status: "idle" });
    setOAuth2Error(null);
  }

  const activeJobs = queue.filter(
    (j) => j.status === "downloading" || j.status === "encoding"
  );
  const doneJobs = queue.filter(
    (j) => j.status === "ready" || j.status === "error"
  );
  const visibleQueue = [...activeJobs, ...doneJobs];

  const isOAuth2Connected = oauth2.connected || oauth2.status === "complete";
  const isOAuth2Pending = oauth2.status === "pending";

  return (
    <div className="min-h-screen bg-[#111] text-white font-sans">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-[#111]/95 backdrop-blur border-b border-white/6">
        <div className="max-w-xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-[#e53935] flex items-center justify-center">
              <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.69a8.27 8.27 0 004.84 1.55V6.79a4.85 4.85 0 01-1.07-.1z"/>
              </svg>
            </div>
            <span className="font-bold text-white text-sm tracking-tight">YT Downloader</span>
          </div>

          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-xs text-gray-400">
            {isOAuth2Connected ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                YouTube Conectado
              </>
            ) : cookiesConfigured ? (
              <>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
                Cookies
                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
              </>
            ) : (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-gray-600" />
                Sem autenticação
              </>
            )}
          </div>
        </div>
      </header>

      <div className="max-w-xl mx-auto px-4 pb-12">
        {/* Search section */}
        <div className="pt-6 pb-4">
          <form onSubmit={handleSearch} className="flex gap-2">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Cole o link do YouTube aqui…"
              className="flex-1 bg-[#1c1c1c] border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder:text-gray-500 outline-none focus:border-[#e53935]/60 transition-colors"
            />
            <button
              type="submit"
              disabled={searching || !url.trim()}
              className="px-5 py-3 rounded-xl bg-[#e53935] hover:bg-[#c62828] disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-sm transition-colors whitespace-nowrap flex items-center gap-2"
            >
              {searching ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Buscando…
                </>
              ) : (
                "Buscar Vídeo"
              )}
            </button>
          </form>

          {searchError && (
            <div className="mt-3 p-3 rounded-xl bg-red-500/10 border border-red-500/20">
              <p className="text-red-400 text-sm">{searchError}</p>
            </div>
          )}
        </div>

        {/* Video info card */}
        {videoInfo && (
          <div className="bg-[#161616] border border-white/8 rounded-2xl overflow-hidden mb-6">
            <div className="w-full aspect-video bg-black">
              <img
                src={videoInfo.thumbnail}
                alt={videoInfo.title}
                className="w-full h-full object-cover"
              />
            </div>

            <div className="p-4">
              <h2 className="text-white font-semibold text-base mb-4 leading-snug">
                {videoInfo.title}
              </h2>

              <div className="bg-[#111] border border-white/8 rounded-xl p-3 mb-4">
                <p className="text-[#22c55e] font-bold text-sm mb-2">
                  Otimizado para Adobe After Effects
                </p>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-300">
                  {["H264 / ProRes", "CFR 30fps", "yuv420p", "AAC / PCM", "GOP curto"].map((feat) => (
                    <span key={feat} className="flex items-center gap-1">
                      <span className="text-[#22c55e]">✅</span> {feat}
                    </span>
                  ))}
                </div>
              </div>

              {videoInfo.qualities.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-2">
                    MP4 — H264 (LEVE, COMPATÍVEL)
                  </p>
                  {videoInfo.qualities.map((q) => (
                    <button
                      key={`${q.height}-${q.codec}`}
                      onClick={() => handleDownload(q)}
                      className="w-full flex items-center justify-between px-4 py-3.5 rounded-xl bg-[#22c55e] hover:bg-[#16a34a] active:scale-[0.98] transition-all text-white font-bold"
                    >
                      <span className="flex items-center gap-2 text-base">
                        <span>⬇️</span>
                        Baixar {q.height}p MP4
                      </span>
                      <span className="flex items-center gap-2 text-xs font-normal opacity-90">
                        <span className="px-2 py-0.5 rounded bg-black/20 font-mono">
                          H264 · CFR 30fps · AAC
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500 text-sm text-center py-2">
                  Nenhuma qualidade disponível para esse vídeo.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Auth section */}
        <div className="bg-[#161616] border border-white/8 rounded-2xl p-4 mb-6 space-y-3">

          {/* OAuth2 panel */}
          {isOAuth2Connected ? (
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-green-500/10 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-white font-medium text-sm">YouTube Conectado</span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-500/15 text-green-400 border border-green-500/20">
                    ✓ OAUTH2
                  </span>
                </div>
                <p className="text-gray-500 text-xs mt-0.5">
                  Downloads funcionam em qualquer IP, inclusive servidores.
                </p>
              </div>
              <button
                onClick={handleDisconnectOAuth2}
                className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-red-500/15 border border-white/10 hover:border-red-500/30 text-xs text-gray-400 hover:text-red-400 transition-colors"
              >
                Desconectar
              </button>
            </div>
          ) : isOAuth2Pending ? (
            /* Device flow in progress */
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-yellow-500/10 flex items-center justify-center flex-shrink-0">
                  <span className="w-5 h-5 border-2 border-yellow-500/30 border-t-yellow-400 rounded-full animate-spin block" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-white font-medium text-sm">Aguardando autorização…</span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-yellow-500/15 text-yellow-400 border border-yellow-500/20">
                      PENDENTE
                    </span>
                  </div>
                  <p className="text-gray-500 text-xs mt-0.5">
                    Siga as instruções abaixo para autorizar
                  </p>
                </div>
                <button
                  onClick={handleCancelOAuth2}
                  className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-xs text-gray-400 transition-colors"
                >
                  Cancelar
                </button>
              </div>

              {(oauth2.deviceUrl || oauth2.userCode) && (
                <div className="bg-[#111] border border-yellow-500/20 rounded-xl p-4 space-y-3">
                  <p className="text-yellow-400 font-semibold text-sm">
                    Siga estes passos no seu celular ou computador:
                  </p>
                  <div className="space-y-2">
                    <div className="flex items-start gap-2">
                      <span className="w-5 h-5 rounded-full bg-yellow-500/20 text-yellow-400 text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">1</span>
                      <div>
                        <p className="text-gray-300 text-sm">Acesse este endereço:</p>
                        {oauth2.deviceUrl ? (
                          <a
                            href={oauth2.deviceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:text-blue-300 text-sm font-mono underline break-all"
                          >
                            {oauth2.deviceUrl}
                          </a>
                        ) : (
                          <span className="text-gray-500 text-sm font-mono">https://google.com/device</span>
                        )}
                      </div>
                    </div>
                    {oauth2.userCode && (
                      <div className="flex items-start gap-2">
                        <span className="w-5 h-5 rounded-full bg-yellow-500/20 text-yellow-400 text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">2</span>
                        <div>
                          <p className="text-gray-300 text-sm">Insira o código:</p>
                          <span className="text-white font-mono font-bold text-lg tracking-widest bg-white/5 px-3 py-1 rounded-lg inline-block mt-1">
                            {oauth2.userCode}
                          </span>
                        </div>
                      </div>
                    )}
                    <div className="flex items-start gap-2">
                      <span className="w-5 h-5 rounded-full bg-yellow-500/20 text-yellow-400 text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">{oauth2.userCode ? "3" : "2"}</span>
                      <p className="text-gray-300 text-sm">Faça login com sua conta do YouTube e autorize o acesso.</p>
                    </div>
                  </div>
                  <p className="text-gray-600 text-xs">
                    Esta página detectará a autorização automaticamente (verificando a cada 3s).
                  </p>
                </div>
              )}

              {!oauth2.deviceUrl && (
                <div className="flex items-center gap-2 text-gray-500 text-xs p-2">
                  <span className="w-3 h-3 border border-gray-600 border-t-gray-400 rounded-full animate-spin" />
                  Iniciando autenticação…
                </div>
              )}
            </div>
          ) : (
            /* Not connected — show connect button */
            <div>
              {oauth2.status === "error" && (
                <div className="mb-3 p-3 rounded-xl bg-red-500/10 border border-red-500/20">
                  <p className="text-red-400 text-xs">{oauth2Error || "Erro na autenticação. Tente novamente."}</p>
                </div>
              )}
              <button
                onClick={handleConnectOAuth2}
                disabled={oauth2Loading}
                className="w-full flex items-center gap-3 group"
              >
                <div className="w-9 h-9 rounded-xl bg-[#e53935]/10 flex items-center justify-center flex-shrink-0 group-hover:bg-[#e53935]/20 transition-colors">
                  {oauth2Loading ? (
                    <span className="w-5 h-5 border-2 border-red-500/30 border-t-red-400 rounded-full animate-spin block" />
                  ) : (
                    <svg className="w-5 h-5 text-[#e53935]" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.69a8.27 8.27 0 004.84 1.55V6.79a4.85 4.85 0 01-1.07-.1z"/>
                    </svg>
                  )}
                </div>
                <div className="flex-1 text-left">
                  <div className="flex items-center gap-2">
                    <span className="text-white font-medium text-sm">
                      {oauth2Loading ? "Iniciando…" : "Conectar ao YouTube"}
                    </span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#e53935]/10 text-[#e53935] border border-[#e53935]/20">
                      RECOMENDADO
                    </span>
                  </div>
                  <p className="text-gray-500 text-xs mt-0.5">
                    Necessário para downloads em produção (server IP)
                  </p>
                </div>
                <svg className="w-4 h-4 text-gray-600 group-hover:text-gray-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          )}

          {/* Divider */}
          <div className="border-t border-white/6" />

          {/* Cookies panel — secondary option */}
          {cookiesConfigured ? (
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-green-500/10 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-white font-medium text-sm">Cookies</span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-500/15 text-green-400 border border-green-500/20">
                    ✓ ATIVO
                  </span>
                </div>
                <p className="text-gray-500 text-xs mt-0.5">
                  Cookies salvos. Adicione novamente quando expirarem.
                </p>
              </div>
              <button
                onClick={handleRemoveCookies}
                disabled={removingCookies}
                className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-red-500/15 border border-white/10 hover:border-red-500/30 text-xs text-gray-400 hover:text-red-400 transition-colors disabled:opacity-50"
              >
                {removingCookies ? "…" : "Remover"}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowCookies(true)}
              className="w-full flex items-center gap-3 group"
            >
              <div className="w-9 h-9 rounded-xl bg-white/5 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
              </div>
              <div className="flex-1 text-left">
                <span className="text-gray-400 font-medium text-sm">Cookies (alternativo)</span>
                <p className="text-gray-600 text-xs mt-0.5">Para vídeos com restrição de idade</p>
              </div>
              <svg className="w-4 h-4 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </div>

        {/* Queue */}
        {visibleQueue.length > 0 && (
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-3">
              Fila de Renderização
            </p>
            <div className="space-y-2">
              {visibleQueue.map((job) => (
                <QueueItem key={job.id} job={job} onCancel={handleCancel} />
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {!videoInfo && visibleQueue.length === 0 && !searching && !searchError && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-2xl bg-[#e53935]/10 flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-[#e53935]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
            </div>
            <p className="text-gray-400 font-medium">Cole um link do YouTube acima</p>
            <p className="text-gray-600 text-sm mt-1">
              Baixe vídeos em H264 otimizados para After Effects
            </p>
          </div>
        )}
      </div>

      {/* Cookies modal */}
      <CookiesModal
        open={showCookies}
        onClose={() => setShowCookies(false)}
        onSaved={() => { setCookiesConfigured(true); setShowCookies(false); }}
      />
    </div>
  );
}
