import { useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import { SOUNDS } from '@/lib/sounds';
import type { BoardSound } from '@/lib/useUserSounds';

const ICON_OPTIONS = [
  'Volume2', 'Music', 'Zap', 'Laugh', 'Frown', 'AlertTriangle',
  'Box', 'Copy', 'Trees', 'Star', 'Heart', 'Flame',
];

const COLOR_OPTIONS = [
  '#f97316', '#ef4444', '#eab308', '#22c55e',
  '#3b82f6', '#8b5cf6', '#f43f5e', '#84cc16',
  '#06b6d4', '#ec4899', '#a855f7', '#ffffff',
];

const ICONS_MAP = Icons as unknown as Record<string, Icons.LucideIcon>;

type Tab = 'builtin' | 'upload';

type Props = {
  existingSoundIds: string[];
  onAddBuiltin: (soundId: string) => Promise<void>;
  onAddCustom: (file: File, name: string, color: string, icon: string) => Promise<void>;
  onClose: () => void;
};

export default function AddSoundModal({ existingSoundIds, onAddBuiltin, onAddCustom, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('builtin');
  const [loading, setLoading] = useState(false);

  // Upload form state
  const [file, setFile] = useState<File | null>(null);
  const [customName, setCustomName] = useState('');
  const [customColor, setCustomColor] = useState('#f97316');
  const [customIcon, setCustomIcon] = useState('Volume2');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAddBuiltin = async (soundId: string) => {
    setLoading(true);
    await onAddBuiltin(soundId);
    setLoading(false);
    onClose();
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !customName.trim()) return;
    setLoading(true);
    await onAddCustom(file, customName.trim(), customColor, customIcon);
    setLoading(false);
    onClose();
  };

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const dropped = e.dataTransfer.files[0];
    if (dropped && dropped.type.startsWith('audio/') || dropped?.name.match(/\.(mp3|mp4|wav|ogg|webm|m4a)$/i)) {
      setFile(dropped);
      if (!customName) setCustomName(dropped.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-md bg-[#111113] border border-white/10 rounded-2xl shadow-2xl flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 flex-shrink-0">
          <h2 className="text-base font-semibold">Add Sound</h2>
          <button onClick={onClose} className="text-white/40 hover:text-white transition">
            <Icons.X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex px-5 pt-4 gap-2 flex-shrink-0">
          {(['builtin', 'upload'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                tab === t ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'
              }`}
            >
              {t === 'builtin' ? 'Sound Library' : 'Upload Your Own'}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'builtin' && (
            <div className="grid grid-cols-2 gap-2">
              {SOUNDS.map((sound) => {
                const alreadyAdded = existingSoundIds.includes(sound.id);
                const Icon = ICONS_MAP[sound.icon ?? 'Volume2'] ?? Icons.Volume2;
                return (
                  <button
                    key={sound.id}
                    onClick={() => !alreadyAdded && handleAddBuiltin(sound.id)}
                    disabled={alreadyAdded || loading}
                    className={`flex items-center gap-3 p-3 rounded-xl border text-left transition ${
                      alreadyAdded
                        ? 'border-white/5 bg-white/[0.02] opacity-40 cursor-not-allowed'
                        : 'border-white/10 bg-white/[0.04] hover:border-white/25 hover:bg-white/[0.08] cursor-pointer'
                    }`}
                  >
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: `${sound.color ?? '#f97316'}25` }}
                    >
                      <Icon className="w-4 h-4" style={{ color: sound.color ?? '#f97316' }} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-white truncate">{sound.name}</p>
                      {alreadyAdded && <p className="text-xs text-white/30">Added</p>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {tab === 'upload' && (
            <form onSubmit={handleUploadSubmit} className="space-y-4">
              {/* Drop zone */}
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleFileDrop}
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-white/15 rounded-xl p-6 text-center cursor-pointer hover:border-orange-500/50 hover:bg-orange-500/5 transition"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*,.mp4,.mp3,.wav,.ogg,.webm,.m4a"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      setFile(f);
                      if (!customName) setCustomName(f.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '));
                    }
                  }}
                />
                {file ? (
                  <div className="flex items-center justify-center gap-2 text-sm text-white/80">
                    <Icons.FileAudio className="w-5 h-5 text-orange-400" />
                    <span className="truncate max-w-xs">{file.name}</span>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setFile(null); }}
                      className="text-white/30 hover:text-white/70"
                    >
                      <Icons.X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <>
                    <Icons.Upload className="w-8 h-8 text-white/20 mx-auto mb-2" />
                    <p className="text-sm text-white/50">Drop an audio file here, or click to browse</p>
                    <p className="text-xs text-white/25 mt-1">MP3, MP4, WAV, OGG, M4A</p>
                  </>
                )}
              </div>

              {/* Name */}
              <div>
                <label className="block text-xs text-white/50 mb-1.5">Name</label>
                <input
                  type="text"
                  required
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="My Sound"
                  className="w-full bg-white/[0.06] border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-white/25 focus:outline-none focus:border-orange-500/60 focus:ring-1 focus:ring-orange-500/30 transition"
                />
              </div>

              {/* Color */}
              <div>
                <label className="block text-xs text-white/50 mb-2">Color</label>
                <div className="flex flex-wrap gap-2">
                  {COLOR_OPTIONS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setCustomColor(c)}
                      className={`w-7 h-7 rounded-full transition ring-offset-[#111113] ${
                        customColor === c ? 'ring-2 ring-white ring-offset-2' : 'hover:scale-110'
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>

              {/* Icon */}
              <div>
                <label className="block text-xs text-white/50 mb-2">Icon</label>
                <div className="flex flex-wrap gap-2">
                  {ICON_OPTIONS.map((name) => {
                    const Ic = ICONS_MAP[name] ?? Icons.Volume2;
                    return (
                      <button
                        key={name}
                        type="button"
                        onClick={() => setCustomIcon(name)}
                        className={`w-9 h-9 rounded-lg flex items-center justify-center transition ${
                          customIcon === name
                            ? 'bg-white/20 text-white'
                            : 'bg-white/[0.05] text-white/40 hover:bg-white/10 hover:text-white/80'
                        }`}
                      >
                        <Ic className="w-4 h-4" />
                      </button>
                    );
                  })}
                </div>
              </div>

              <button
                type="submit"
                disabled={!file || !customName.trim() || loading}
                className="w-full py-2.5 rounded-xl bg-gradient-to-r from-orange-500 to-pink-500 text-sm font-semibold text-white hover:opacity-90 active:opacity-80 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <Icons.Loader2 className="w-4 h-4 animate-spin" />
                    Uploading…
                  </span>
                ) : 'Add to Board'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
