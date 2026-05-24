import { useState } from "react";
import { saveCookies } from "@/lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export default function CookiesModal({ open, onClose, onSaved }: Props) {
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function handleSave() {
    if (!value.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await saveCookies(value.trim());
      onSaved();
      onClose();
      setValue("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Erro ao salvar");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl w-full max-w-lg p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-white">Cookies de Autenticação</h2>
            <p className="text-sm text-gray-400 mt-0.5">
              Cole os cookies do YouTube no formato Netscape/txt
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-2xl leading-none transition-colors"
          >
            ×
          </button>
        </div>

        <textarea
          className="w-full h-48 bg-[#111] border border-white/10 rounded-xl p-3 text-sm font-mono text-gray-300 resize-none outline-none focus:border-white/30 transition-colors placeholder:text-gray-600"
          placeholder="# Netscape HTTP Cookie File&#10;.youtube.com	TRUE	/	FALSE	..."
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />

        {error && (
          <p className="text-red-400 text-sm mt-2">{error}</p>
        )}

        <div className="flex gap-3 mt-4">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-gray-300 text-sm font-medium transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={loading || !value.trim()}
            className="flex-1 py-2.5 rounded-xl bg-[#e53935] hover:bg-[#c62828] disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold transition-colors"
          >
            {loading ? "Salvando…" : "Salvar Cookies"}
          </button>
        </div>
      </div>
    </div>
  );
}
