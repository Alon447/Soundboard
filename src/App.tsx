import { useCallback, useEffect, useRef, useState } from "react";
import * as Icons from "lucide-react";
import { SOUNDS, type Sound } from "@/lib/sounds";
import { playSynth, setSynthVolume } from "@/lib/synth";

const PAD_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "="];
const ICONS = Icons as unknown as Record<string, Icons.LucideIcon>;
const DEFAULT_COLOR = "#f97316";

function assetPath(path: string): string {
  if (path.startsWith("/") || path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }

  return `/${path.replace(/^\/+/, "")}`;
}

function isSynth(path: string): boolean {
  return path.startsWith("synth:");
}

function getIcon(name: string | null | undefined): Icons.LucideIcon {
  return (name && ICONS[name]) || Icons.Music;
}

export default function App() {
  const [volume, setVolume] = useState(0.7);
  const [activeId, setActiveId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const mediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const currentGainRef = useRef(1);
  const timers = useRef<Record<string, number>>({});

  const ensureAudioGraph = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) {
      return null;
    }

    if (!audioContextRef.current) {
      const windowWithWebkit = window as Window & {
        webkitAudioContext?: typeof AudioContext;
      };
      const AudioContextCtor = window.AudioContext ?? windowWithWebkit.webkitAudioContext;
      if (!AudioContextCtor) {
        return null;
      }

      const context = new AudioContextCtor();
      const source = context.createMediaElementSource(audio);
      const gainNode = context.createGain();

      source.connect(gainNode);
      gainNode.connect(context.destination);

      audioContextRef.current = context;
      mediaSourceRef.current = source;
      gainNodeRef.current = gainNode;
    }

    return {
      context: audioContextRef.current,
      gainNode: gainNodeRef.current,
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.volume = 1;
    }

    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = volume * currentGainRef.current;
    }

    setSynthVolume(volume);
  }, [volume]);

  const triggerPad = useCallback(
    (sound: Sound) => {
      if (isSynth(sound.audio_path)) {
        playSynth(sound.audio_path.slice(6));
      } else {
        const audio = audioRef.current;
        if (audio) {
          const graph = ensureAudioGraph();
          currentGainRef.current = sound.gain ?? 1;

          if (graph?.context?.state === "suspended") {
            graph.context.resume().catch((error) => console.error("Audio context resume failed:", error));
          }

          if (graph?.gainNode) {
            graph.gainNode.gain.value = volume * currentGainRef.current;
          } else {
            audio.volume = Math.min(volume * currentGainRef.current, 1);
          }

          audio.src = assetPath(sound.audio_path);
          audio.currentTime = 0;
          audio.play().catch((error) => console.error("Playback failed:", error));
        }
      }

      setActiveId(sound.id);
      if (timers.current[sound.id]) {
        clearTimeout(timers.current[sound.id]);
      }

      timers.current[sound.id] = window.setTimeout(() => {
        setActiveId((current) => (current === sound.id ? null : current));
      }, 300);
    },
    [ensureAudioGraph, volume],
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }

      const index = PAD_KEYS.indexOf(event.key);
      if (index >= 0 && index < SOUNDS.length) {
        event.preventDefault();
        triggerPad(SOUNDS[index]);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [triggerPad]);

  useEffect(() => {
    const timersSnapshot = timers.current;

    return () => {
      Object.values(timersSnapshot).forEach((timer) => clearTimeout(timer));
      audioContextRef.current?.close().catch(() => undefined);
    };
  }, []);

  return (
    <div className="min-h-screen bg-[#0a0a0b] text-white flex flex-col">
      <audio ref={audioRef} />

      <header className="border-b border-white/10 px-6 py-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-pink-500 flex items-center justify-center">
            <Icons.Volume2 className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight">Soundboard</h1>
            <p className="text-xs text-white/50">Local asset mode. Drop files into public/sounds and register them in src/lib/sounds.ts.</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Icons.Volume1 className="w-5 h-5 text-white/50" />
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(event) => setVolume(parseFloat(event.target.value))}
            className="w-28 accent-orange-500"
          />
          <span className="text-xs text-white/40 w-8 text-right tabular-nums">{Math.round(volume * 100)}</span>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        {SOUNDS.length === 0 ? (
          <div className="max-w-xl w-full rounded-3xl border border-white/10 bg-white/[0.03] p-6 sm:p-8">
            <div className="flex items-center gap-3 mb-4">
              <Icons.FolderOpen className="w-7 h-7 text-orange-400" />
              <div>
                <p className="text-lg font-semibold text-white/80">No local sounds configured</p>
                <p className="text-sm text-white/45">Add your mp3 or mp4 files to the project and list them in the local manifest.</p>
              </div>
            </div>

            <div className="space-y-3 text-sm text-white/60">
              <p>1. Put audio files in public/sounds.</p>
              <p>2. Put optional pad images in public/images.</p>
              <p>3. Add entries to src/lib/sounds.ts using paths like /sounds/airhorn.mp3.</p>
              <p>4. Run npm run dev and use keys 1-9, 0, -, = to trigger pads.</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3 max-w-4xl w-full">
            {SOUNDS.map((sound, index) => {
              const isActive = activeId === sound.id;
              const keyHint = PAD_KEYS[index];
              const Icon = getIcon(sound.icon);
              const hasImage = Boolean(sound.image_path);
              const color = sound.color ?? DEFAULT_COLOR;

              return (
                <button
                  key={sound.id}
                  onPointerDown={() => triggerPad(sound)}
                  className={`group relative aspect-square rounded-2xl border overflow-hidden transition-all duration-150 select-none touch-none ${
                    isActive ? "scale-95 border-white/40" : "border-white/10 hover:border-white/30 hover:scale-[1.03]"
                  }`}
                  style={
                    isActive ? { boxShadow: `0 0 24px ${color}80, inset 0 0 16px ${color}40` } : undefined
                  }
                >
                  {hasImage ? (
                    <img src={assetPath(sound.image_path ?? "")} alt={sound.name} className="absolute inset-0 w-full h-full object-cover" />
                  ) : (
                    <div className="absolute inset-0 bg-gradient-to-b from-white/[0.06] to-white/[0.02]" />
                  )}
                  <div className="absolute inset-0 bg-black/30" />

                  {isActive && (
                    <div
                      className="absolute inset-0"
                      style={{ background: `radial-gradient(circle at center, ${color}40, transparent 70%)` }}
                    />
                  )}

                  <div className="relative h-full flex flex-col items-center justify-center gap-2 p-2">
                    {!hasImage && <Icon className="w-7 h-7" style={{ color: isActive ? color : "#ffffff80" }} />}
                    <span className="text-xs font-semibold text-white truncate w-full text-center drop-shadow-lg">{sound.name}</span>
                  </div>

                  {keyHint && <span className="absolute top-1.5 right-2 text-[10px] font-mono text-white/40">{keyHint}</span>}
                  <div className="absolute top-1.5 left-2 w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
                </button>
              );
            })}
          </div>
        )}
      </main>

      <footer className="border-t border-white/10 px-6 py-3 flex items-center justify-center gap-2 text-xs text-white/40">
        {activeId ? (
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            Playing: {SOUNDS.find((sound) => sound.id === activeId)?.name}
          </span>
        ) : (
          <span>
            {SOUNDS.length} sound{SOUNDS.length !== 1 ? "s" : ""} loaded
            {SOUNDS.length > 0 ? " - keys 1-9, 0, -, = trigger pads" : ""}
          </span>
        )}
      </footer>
    </div>
  );
}