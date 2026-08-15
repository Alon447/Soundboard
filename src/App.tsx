import { useCallback, useEffect } from 'react';
import * as Icons from 'lucide-react';
import {
  Button,
  Slider,
  SliderOutput,
  SliderThumb,
  SliderTrack,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Spinner,
} from '@heroui/react';
import { useAuth } from '@/lib/useAuth';
import { useUserSounds, type BoardSound } from '@/lib/useUserSounds';
import { useSoundStore } from '@/store/soundStore';
import { playSynth } from '@/lib/synth';
import AuthPage from '@/components/AuthPage';
import AddSoundModal from '@/components/AddSoundModal';

const PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];
const ICONS = Icons as unknown as Record<string, Icons.LucideIcon>;
const DEFAULT_COLOR = '#f97316';

function assetPath(p: string): string {
  if (!p) return '';
  if (p.startsWith('/') || p.startsWith('http://') || p.startsWith('https://')) return p;
  return `/${p.replace(/^\/+/, '')}`;
}

function isSynth(p: string): boolean {
  return p.startsWith('synth:');
}

function getIcon(name: string | null | undefined): Icons.LucideIcon {
  return (name && ICONS[name]) || Icons.Music;
}

// ---------------------------------------------------------------------------
// Volume popover — HeroUI Slider compound
// ---------------------------------------------------------------------------
function VolumePopover({
  dbId,
  gain,
  color,
  onUpdate,
  onClose,
}: {
  dbId: string;
  gain: number;
  color: string;
  onUpdate: (dbId: string, gain: number) => void;
  onClose: () => void;
}) {
  // Close on outside click
  useEffect(() => {
    const id = setTimeout(() => {
      const handler = (e: MouseEvent) => {
        const el = document.getElementById(`vol-popover-${dbId}`);
        if (el && !el.contains(e.target as Node)) onClose();
      };
      document.addEventListener('mousedown', handler);
      return () => document.removeEventListener('mousedown', handler);
    }, 50);
    return () => clearTimeout(id);
  }, [dbId, onClose]);

  return (
    <div
      id={`vol-popover-${dbId}`}
      className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-50 w-40 bg-[#1c1c1f] border border-white/15 rounded-xl shadow-2xl p-3 flex flex-col gap-2.5"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-white/50 font-medium">Volume</span>
        <span className="text-[10px] font-mono tabular-nums" style={{ color }}>
          {Math.round(gain * 100)}%
        </span>
      </div>

      {/* HeroUI Slider — React Aria-based, fully accessible */}
      <Slider
        minValue={0}
        maxValue={4}
        step={0.05}
        value={gain}
        onChange={(v) => onUpdate(dbId, v as number)}
        aria-label="Sound volume"
        className="w-full"
      >
        <SliderOutput />
        <SliderTrack>
          <SliderThumb />
        </SliderTrack>
      </Slider>

      {/* Quick presets */}
      <div className="flex gap-1">
        {[1, 2, 3, 4].map((v) => (
          <button
            key={v}
            onClick={() => onUpdate(dbId, v)}
            className={`flex-1 text-[9px] py-1 rounded-md transition ${
              Math.round(gain) === v
                ? 'bg-white/20 text-white'
                : 'bg-white/[0.05] text-white/40 hover:bg-white/10'
            }`}
          >
            {v * 100}%
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  const { user, loading: authLoading, signOut } = useAuth();
  const { sounds, loading: soundsLoading, error, addBuiltinSound, addCustomSound, removeSound, moveSound, updateGain } = useUserSounds();

  // Zustand store — pull only what each section needs (fine-grained subscriptions)
  const volume            = useSoundStore((s) => s.volume);
  const setVolume         = useSoundStore((s) => s.setVolume);
  const activeId          = useSoundStore((s) => s.activeId);
  const setActiveId       = useSoundStore((s) => s.setActiveId);
  const editMode          = useSoundStore((s) => s.editMode);
  const toggleEditMode    = useSoundStore((s) => s.toggleEditMode);
  const showAddModal      = useSoundStore((s) => s.showAddModal);
  const setShowAddModal   = useSoundStore((s) => s.setShowAddModal);
  const volumePopoverId   = useSoundStore((s) => s.volumePopoverId);
  const toggleVolumePopover = useSoundStore((s) => s.toggleVolumePopover);
  const setVolumePopoverId  = useSoundStore((s) => s.setVolumePopoverId);
  const getAudioContext   = useSoundStore((s) => s.getAudioContext);
  const audio             = useSoundStore((s) => s.audio);

  // ---- Audio engine --------------------------------------------------------

  const getBuffer = useCallback(
    async (url: string, ctx: AudioContext): Promise<AudioBuffer> => {
      const cached = audio.buffers.get(url);
      if (cached) return cached;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
      const buf = await ctx.decodeAudioData(await res.arrayBuffer());
      audio.buffers.set(url, buf);
      return buf;
    },
    [audio],
  );

  const triggerPad = useCallback(
    async (sound: BoardSound) => {
      // Visual flash — immediate
      setActiveId(sound.id);
      if (audio.timers[sound.id]) clearTimeout(audio.timers[sound.id]);
      audio.timers[sound.id] = window.setTimeout(
        () => setActiveId(null),
        300,
      );

      if (isSynth(sound.audio_path)) {
        playSynth(sound.audio_path.slice(6));
        return;
      }

      try {
        const ctx = getAudioContext();
        if (ctx.state === 'suspended') await ctx.resume();

        const prev = audio.sources.get(sound.id);
        if (prev) { try { prev.stop(); } catch { /* already ended */ } audio.sources.delete(sound.id); }

        const buffer = await getBuffer(assetPath(sound.audio_path), ctx);

        const soundGain = ctx.createGain();
        soundGain.gain.value = sound.gain ?? 1;
        soundGain.connect(audio.masterGain!);

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(soundGain);
        source.start(0);
        audio.sources.set(sound.id, source);
        source.onended = () => audio.sources.delete(sound.id);
      } catch (err) {
        console.error('Playback failed:', err);
      }
    },
    [audio, getAudioContext, getBuffer, setActiveId],
  );

  // Keyboard shortcuts
  useEffect(() => {
    if (editMode) return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const i = PAD_KEYS.indexOf(e.key);
      if (i >= 0 && i < sounds.length) { e.preventDefault(); triggerPad(sounds[i]); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [triggerPad, sounds, editMode]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      Object.values(audio.timers).forEach(clearTimeout);
      audio.ctx?.close().catch(() => undefined);
    };
  }, [audio]);

  // ---- Auth guard ----------------------------------------------------------
  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#0a0a0b] flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }
  if (!user) return <AuthPage />;

  const existingSoundIds = sounds.map((s) => s.id);

  return (
    <div className="min-h-screen bg-[#0a0a0b] text-white flex flex-col">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="border-b border-white/10 px-6 py-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-linear-to-br from-orange-500 to-pink-500 flex items-center justify-center">
            <Icons.Volume2 className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight">Soundboard</h1>
            <p className="text-xs text-white/40">{user.email}</p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Global volume — HeroUI Slider */}
          <div className="flex items-center gap-2 min-w-[160px]">
            <Icons.Volume1 className="w-4 h-4 text-white/50 shrink-0" />
            <Slider
              minValue={0}
              maxValue={1}
              step={0.01}
              value={volume}
              onChange={(v) => setVolume(v as number)}
              aria-label="Master volume"
              className="flex-1"
            >
              <SliderOutput className="text-xs text-white/40 tabular-nums w-8 text-right" />
              <SliderTrack>
                <SliderThumb />
              </SliderTrack>
            </Slider>
          </div>

          {/* Edit mode */}
          <Button
            variant={editMode ? 'solid' : 'ghost'}
            color={editMode ? 'warning' : 'default'}
            size="sm"
            onPress={toggleEditMode}
            startContent={<Icons.Pencil className="w-3.5 h-3.5" />}
          >
            {editMode ? 'Done' : 'Edit'}
          </Button>

          {/* Add sound */}
          <Button
            variant="flat"
            color="warning"
            size="sm"
            onPress={() => setShowAddModal(true)}
            startContent={<Icons.Plus className="w-3.5 h-3.5" />}
          >
            Add Sound
          </Button>

          {/* Sign out */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button isIconOnly variant="ghost" size="sm" onPress={signOut} aria-label="Sign out">
                <Icons.LogOut className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Sign out</TooltipContent>
          </Tooltip>
        </div>
      </header>

      {/* ── Main ───────────────────────────────────────────────────────────── */}
      <main className="flex-1 flex items-center justify-center p-6">
        {soundsLoading ? (
          <Spinner size="lg" />
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
            <Button
              color="warning"
              variant="flat"
              onPress={() => setShowAddModal(true)}
              startContent={<Icons.Plus className="w-4 h-4" />}
            >
              Add your first sound
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3 max-w-4xl w-full">
            {sounds.map((sound, index) => {
              const isActive = activeId === sound.id;
              const keyHint = PAD_KEYS[index];
              const Icon = getIcon(sound.icon);
              const hasImage = Boolean(sound.image_path);
              const color = sound.color ?? DEFAULT_COLOR;
              const isVolumeOpen = volumePopoverId === sound.dbId;

              return (
                <div key={sound.dbId} className="relative group">
                  {isVolumeOpen && (
                    <VolumePopover
                      dbId={sound.dbId}
                      gain={sound.gain}
                      color={color}
                      onUpdate={updateGain}
                      onClose={() => setVolumePopoverId(null)}
                    />
                  )}

                  <button
                    onPointerDown={() => !editMode && triggerPad(sound)}
                    className={[
                      'relative w-full aspect-square rounded-2xl border overflow-hidden transition-all duration-150 select-none touch-none',
                      editMode
                        ? 'border-white/20 cursor-default opacity-90'
                        : isActive
                        ? 'scale-95 border-white/40'
                        : 'border-white/10 hover:border-white/30 hover:scale-[1.03]',
                    ].join(' ')}
                    style={isActive && !editMode ? { boxShadow: `0 0 24px ${color}80, inset 0 0 16px ${color}40` } : undefined}
                  >
                    {hasImage ? (
                      <img src={assetPath(sound.image_path ?? '')} alt={sound.name} className="absolute inset-0 w-full h-full object-cover" />
                    ) : (
                      <div className="absolute inset-0 bg-linear-to-b from-white/[0.06] to-white/[0.02]" />
                    )}
                    <div className="absolute inset-0 bg-black/30" />
                    {isActive && !editMode && (
                      <div className="absolute inset-0" style={{ background: `radial-gradient(circle at center, ${color}40, transparent 70%)` }} />
                    )}
                    <div className="relative h-full flex flex-col items-center justify-center gap-2 p-2">
                      {!hasImage && <Icon className="w-7 h-7" style={{ color: isActive ? color : '#ffffff80' }} />}
                      <span className="text-xs font-semibold text-white truncate w-full text-center drop-shadow-lg">{sound.name}</span>
                    </div>
                    {keyHint && !editMode && (
                      <span className="absolute top-1.5 right-2 text-[10px] font-mono text-white/40">{keyHint}</span>
                    )}
                    <div className="absolute top-1.5 left-2 w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
                    {!editMode && sound.gain !== 1 && (
                      <span className="absolute bottom-1.5 right-2 text-[9px] font-mono text-white/30">
                        {Math.round(sound.gain * 100)}%
                      </span>
                    )}
                  </button>

                  {/* Edit-mode overlay */}
                  {editMode && (
                    <div className="absolute inset-0 flex flex-col items-center justify-between pt-1.5 pb-1.5 pointer-events-none">
                      {/* Volume button */}
                      <div className="flex justify-center w-full pointer-events-auto">
                        <button
                          onClick={() => toggleVolumePopover(sound.dbId)}
                          className={[
                            'flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium transition',
                            isVolumeOpen ? 'bg-white/25 text-white' : 'bg-black/60 text-white/60 hover:text-white hover:bg-black/80',
                          ].join(' ')}
                        >
                          <Icons.Volume2 className="w-3 h-3" />
                          {Math.round(sound.gain * 100)}%
                        </button>
                      </div>
                      {/* Move + delete */}
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

            {/* Add more pad */}
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

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer className="border-t border-white/10 px-6 py-3 flex items-center justify-center text-xs text-white/40">
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

      {/* ── Add Sound Modal ─────────────────────────────────────────────────── */}
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
