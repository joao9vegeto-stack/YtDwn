import { JobStatus, cancelJob, getFileUrl } from "@/lib/api";

interface Props {
  job: JobStatus;
  onCancel: (id: string) => void;
}

const CODEC_BADGE: Record<string, string> = {
  h264: "H264",
  prores: "ProRes",
};

export default function QueueItem({ job, onCancel }: Props) {
  const codecLabel = job.safeFilename?.includes("H264") ? "H264" : "H264";

  const statusColor =
    job.status === "ready"
      ? "text-green-400"
      : job.status === "error"
      ? "text-red-400"
      : "text-gray-300";

  const barColor =
    job.status === "error"
      ? "bg-red-500"
      : job.status === "ready"
      ? "bg-green-500"
      : "progress-animated";

  return (
    <div className="flex items-start gap-3 bg-[#161616] border border-white/8 rounded-xl p-3">
      {/* Thumbnail */}
      <div className="w-20 h-14 rounded-lg overflow-hidden flex-shrink-0 bg-black">
        {job.thumbnail ? (
          <img
            src={job.thumbnail}
            alt={job.title || ""}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full bg-white/5 flex items-center justify-center">
            <svg className="w-6 h-6 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.069A1 1 0 0121 8.868v6.264a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
            </svg>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-bold bg-[#22c55e]/15 text-[#22c55e]">
            {codecLabel}
          </span>
          <span className="text-white text-sm font-medium truncate">
            {job.title || job.safeFilename || `Job ${job.id.slice(-6)}`}
          </span>
        </div>

        <p className={`text-xs ${statusColor} mb-2`}>
          {job.message}
          {job.eta && <span className="text-gray-500 ml-1">· {job.eta}</span>}
          {job.sizeMB && job.status === "ready" && (
            <span className="text-gray-500 ml-1">· {job.sizeMB} MB</span>
          )}
        </p>

        {/* Progress bar */}
        {job.status !== "error" && (
          <div className="h-1 bg-white/8 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${barColor}`}
              style={{ width: `${job.progress}%` }}
            />
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
        {job.status === "ready" ? (
          <a
            href={getFileUrl(job.id)}
            download={job.safeFilename || undefined}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#22c55e] hover:bg-[#16a34a] text-white text-xs font-bold transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Baixar
          </a>
        ) : job.status === "error" ? null : (
          <button
            onClick={() => onCancel(job.id)}
            className="w-6 h-6 rounded-full bg-white/8 hover:bg-red-500/20 text-gray-400 hover:text-red-400 flex items-center justify-center transition-colors"
            title="Cancelar"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
