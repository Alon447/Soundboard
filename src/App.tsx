import { useCallback, useEffect, useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import { useAuth } from '@/lib/useAuth';
import { useUserSounds, type BoardSound } from '@/lib/useUserSounds';
import { playSynth, setSynthVolume } from '@/lib/synth';
import AuthPage from '@/components/AuthPage';
import AddSoundModal from '@/components/AddSoundModal';

const PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];
const ICONS = Icons as unknown as Record<string, Icons.LucideIcon>;
const DEFAULT_COLOR = '#f97316';

function assetPath(path: string): string {
  if (!path) return '';
  if (path.startsWith('/') || path.startsWith('http://') || path.startsWith('https://')) return path;
  return `/${path.replace(/^\/+/, '')}`;
}

function isSynth(path: string): boolean {
  return path.startsWith('synth:');
}

function getIcon(name: string | null | undefined): Icons.LucideIcon {
  return (name && ICONS[name]) || Icons.Music;
}

export default function App() {
  const { user, loading: authLoading, signOut } = useAuth();
  const { sounds, loading: soundsLoading, error, addBuiltinSound, addCustomSound, removeSound, moveSound } = useUserSounds();

  const [volume, setVolume] = useState(0.7);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editMode, setEditMode] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const mediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const currentGainRef = useRef(1);
  const timers = useRef<Record<string, number>>({});

  const ensureAudioGraph = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return null;

    if (!audioContextRef.current) {
      const windowWithWebkit = window as Window & { webkitAudioContext?: typeof AudioContext };
      const AudioContextCtor = window.AudioContext ?? windowWithWebkit.webkitAudioContext;
      if (!AudioContextCtor) return null;

      const context = new AudioContextCtor();
      const source = context.createMediaElementSource(audio);
      const gainNode = context.createGain();

      source.connect(gainNode);
      gainNode.connect(context.destination);

      audioContextRef.current = context;
      mediaSourceRef.current = source;
      gainNodeRef.current = gainNode;
    }

    return { context: audioContextRef.current, gainNode: gainNodeRef.current };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.volume = 1;
    if (gainNodeRef.current) gainNodeRef.current.gain.value = volume * currentGainRef.current;
    setSynthVolume(volume);
  }, [volume]);

  const triggerPad = useCallback((sound: BoardSound) => {
    if (isSynth(sound.audio_path)) {
      playSynth(sound.audio_path.slice(6));
    } else {
      const audio = audioRef.current;
      if (audio) {
        const graph = ensureAudioGraph();
        currentGainRef.current = sound.gain ?? 1;

        if (graph?.context?.state === 'suspended') {
          graph.context.resume().catch((err) => console.error('Audio context resume failed:', err));
        }

        if (graph?.gainNode) {
          graph.gainNode.gain.value = volume * currentGainRef.current;
        } else {
          audio.volume = Math.min(volume * currentGainRef.current, 1);
        }

        audio.src = assetPath(sound.audio_path);
        audio.currentTime = 0;
        audio.play().catch((err) => console.error('Playback failed:', err));
      }
    }

    setActiveId(sound.id);
    if (timers.current[sound.id]) clearTimeout(timers.current[sound.id]);
    timers.current[sound.id] = window.setTimeout(() => {
      setActiveId((current) => (current === sound.id ? null : current));
    }, 300);
  }, [ensureAudioGraph, volume]);

  useEffect(() => {
    if (editMode) return;
    const handler = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      const index = PAD_KEYS.indexOf(event.key);
      if (index >= 0 && index < sounds.length) {
        event.preventDefault();
        triggerPad(sounds[index]);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [triggerPad, sounds, editMode]);

  useEffect(() => {
    const timersSnapshot = timers.current;
    return () => {
      Object.values(timersSnapshot).forEach((timer) => clearTimeout(timer));
      audioContextRef.current?.close().catch(() => undefined);
    };
  }, []);

  // Show loading spinner while checking auth
  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#0a0a0b] flex items-center justify-center">
        <Icons.Loader2 className="w-8 h-8 text-white/30 animate-spin" />
      </div>
    );
  }

  // Not logged in — show auth page
  if (!user) return <AuthPage />;

  const existingSoundIds = sounds.map((s) => s.id);

  return (
    <div className="min-h-screen bg-[#0a0a0b] text-white flex flex-col">
      <audio ref={audioRef} />

      {/* Header */}
      <header className="border-b border-white/10 px-6 py-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-pink-500 flex items-center justify-center">
            <Icons.Volume2 className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight">Soundboard</h1>
            <p className="text-xs text-white/40">{user.email}</p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Volume */}
          <div className="flex items-center gap-2">
            <Icons.Volume1 className="w-5 h-5 text-white/50" />
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              className="w-24 accent-orange-500"
            />
            <span className="text-xs text-white/40 w-8 text-right tabular-nums">
              {Math.round(volume * 100)}
            </span>
          </div>

          {/* Edit mode toggle */}
          <button
            onClick={() => setEditMode((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
              editMode
                ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30'
                : 'bg-white/[0.06] text-white/50 border border-white/10 hover:text-white/80'
            }`}
          >
            <Icons.Pencil className="w-3.5 h-3.5" />
            {editMode ? 'Done' : 'Edit'}
          </button>

          {/* Add sound */}
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-orange-500/20 text-orange-400 border border-orange-500/30 hover:bg-orange-500/30 transition"
          >
            <Icons.Plus className="w-3.5 h-3.5" />
            Add Sound
          </button>

          {/* Sign out */}
          <button
            onClick={signOut}
            title="Sign out"
            className="text-white/30 hover:text-white/70 transition"
          >
            <Icons.LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 flex items-center justify-center p-6">
        {soundsLoading ? (
          <Icons.Loader2 className="w-8 h-8 text-white/20 animate-spin" />
        ) : error ? (
          <p className="text-sm text-red-400">Failed to load sounds: {error}</p>
        ) : sounds.length === 0 ? (
          <div className="max-w-sm w-full text-center space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-white/[0.04] border border-white/10 flex items-center justify-center mx-auto">
              <Icons.Music className="w-8 h-8 text-white/20" />
            </div>
            <div>
              <p className="text-white/60 font-medium">No sounds yet</p>
              <p className="text-sm text-white/30 mt-1">Add sounds from the library or upload your own</p>
            </div>
            <button
              onClick={() => setShowAddModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-orange-500 to-pink-500 text-sm font-semibold text-white hover:opacity-90 transition"
            >
              <Icons.Plus className="w-4 h-4" />
              Add your first sound
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3 max-w-4xl w-full">
            {sounds.map((sound, index) => {
              const isActive = activeId === sound.id;
              const keyHint = PAD_KEYS[index];
              const Icon = getIcon(sound.icon);
              const hasImage = Boolean(sound.image_path);
              const color = sound.color ?? DEFAULT_COLOR;

              return (
                <div key={sound.dbId} className="relative group">
                  <button
                    onPointerDown={() => !editMode && triggerPad(sound)}
                    className={`relative w-full aspect-square rounded-2xl border overflow-hidden transition-all duration-150 select-none touch-none ${
                      editMode
                        ? 'border-white/20 cursor-default opacity-90'
                        : isActive
                        ? 'scale-95 border-white/40'
                        : 'border-white/10 hover:border-white/30 hover:scale-[1.03]'
                    }`}
                    style={isActive && !editMode ? { boxShadow: `0 0 24px ${color}80, inset 0 0 16px ${color}40` } : undefined}
                  >
                    {hasImage ? (
                      <img src={assetPath(sound.image_path ?? '')} alt={sound.name} className="absolute inset-0 w-full h-full object-cover" />
                    ) : (
                      <div className="absolute inset-0 bg-gradient-to-b from-white/[0.06] to-white/[0.02]" />
                    )}
                    <div className="absolute inset-0 bg-black/30" />

                    {isActive && !editMode && (
                      <div
                        className="absolute inset-0"
                        style={{ background: `radial-gradient(circle at center, ${color}40, transparent 70%)` }}
                      />
                    )}

                    <div className="relative h-full flex flex-col items-center justify-center gap-2 p-2">
                      {!hasImage && <Icon className="w-7 h-7" style={{ color: isActive ? color : '#ffffff80' }} />}
                      <span className="text-xs font-semibold text-white truncate w-full text-center drop-shadow-lg">
                        {sound.name}
                      </span>
                    </div>

                    {keyHint && !editMode && (
                      <span className="absolute top-1.5 right-2 text-[10px] font-mono text-white/40">{keyHint}</span>
                    )}
                    <div className="absolute top-1.5 left-2 w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
                  </button>

                  {/* Edit mode controls */}
                  {editMode && (
                    <div className="absolute inset-0 flex flex-col items-center justify-end pb-1.5 gap-1 pointer-events-none">
                      <div className="flex items-center gap-1 pointer-events-auto">
                        <button
                          onClick={() => moveSound(sound.dbId, 'left')}
                          disabled={index === 0}
                          className="w-6 h-6 rounded-md bg-black/70 flex items-center justify-center text-white/60 hover:text-white disabled:opacity-20 transition"
                        >
                          <Icons.ChevronLeft className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => removeSound(sound.dbId)}
                          className="w-6 h-6 rounded-md bg-red-500/80 flex items-center justify-center text-white hover:bg-red-500 transition"
                        >
                          <Icons.Trash2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => moveSound(sound.dbId, 'right')}
                          disabled={index === sounds.length - 1}
                          className="w-6 h-6 rounded-md bg-black/70 flex items-center justify-center text-white/60 hover:text-white disabled:opacity-20 transition"
                        >
                          <Icons.ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Add more button at end of grid */}
            <button
              onClick={() => setShowAddModal(true)}
              className="aspect-square rounded-2xl border border-dashed border-white/15 flex flex-col items-center justify-center gap-1.5 text-white/30 hover:text-white/60 hover:border-white/30 transition"
            >
              <Icons.Plus className="w-6 h-6" />
              <span className="text-xs font-medium">Add</span>
            </button>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-white/10 px-6 py-3 flex items-center justify-center gap-2 text-xs text-white/40">
        {activeId ? (
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            Playing: {sounds.find((s) => s.id === activeId)?.name}
          </span>
        ) : (
          <span>
            {sounds.length} sound{sounds.length !== 1 ? 's' : ''}
            {sounds.length > 0 && !editMode ? ' — keys 1-9, 0, -, = trigger pads' : ''}
            {editMode ? ' — edit mode' : ''}
          </span>
        )}
      </footer>

      {/* Add Sound Modal */}
      {showAddModal && (
        <AddSoundModal
          existingSoundIds={existingSoundIds}
          onAddBuiltin={addBuiltinSound}
          onAddCustom={addCustomSound}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </div>
  );
}
