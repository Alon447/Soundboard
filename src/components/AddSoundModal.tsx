import { useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import {
  Button,
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalCloseTrigger,
  ModalContainer,
  ModalDialog,
  ModalFooter,
  ModalHeader,
  ModalHeading,
  ProgressBar,
  ProgressBarFill,
  ProgressBarTrack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextField,
  TextFieldRoot,
  Input,
} from '@heroui/react';
import { SOUNDS } from '@/lib/sounds';
import { extractAudioFromVideo, type ConvertProgress } from '@/lib/ffmpegConvert';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
const YOUTUBE_SERVER = 'http://localhost:3001';
const VIDEO_EXTENSIONS = /\.(mov|mp4|mkv|webm|avi|flv|m4v|wmv)$/i;
const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/i;

function isVideoFile(file: File) {
  return VIDEO_EXTENSIONS.test(file.name) || (file.type.startsWith('video/') && !file.type.startsWith('audio/'));
}
function isAcceptableFile(file: File) {
  return file.type.startsWith('audio/') || file.type.startsWith('video/') || VIDEO_EXTENSIONS.test(file.name) || AUDIO_EXTENSIONS.test(file.name);
}
function isYouTubeUrl(value: string) {
  try {
    const { hostname } = new URL(value);
    return ['www.youtube.com', 'youtube.com', 'youtu.be', 'm.youtube.com'].includes(hostname);
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ColorPicker({ value, onChange, disabled }: { value: string; onChange: (c: string) => void; disabled?: boolean }) {
  return (
    <div>
      <p className="text-xs text-white/50 mb-2">Color</p>
      <div className="flex flex-wrap gap-2">
        {COLOR_OPTIONS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            disabled={disabled}
            className={[
              'w-7 h-7 rounded-full transition ring-offset-[#111113] disabled:opacity-50',
              value === c ? 'ring-2 ring-white ring-offset-2' : 'hover:scale-110',
            ].join(' ')}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
    </div>
  );
}

function IconPicker({ value, onChange, disabled }: { value: string; onChange: (i: string) => void; disabled?: boolean }) {
  return (
    <div>
      <p className="text-xs text-white/50 mb-2">Icon</p>
      <div className="flex flex-wrap gap-2">
        {ICON_OPTIONS.map((name) => {
          const Ic = ICONS_MAP[name] ?? Icons.Volume2;
          return (
            <button
              key={name}
              type="button"
              onClick={() => onChange(name)}
              disabled={disabled}
              className={[
                'w-9 h-9 rounded-lg flex items-center justify-center transition disabled:opacity-50',
                value === name ? 'bg-white/20 text-white' : 'bg-white/[0.05] text-white/40 hover:bg-white/10 hover:text-white/80',
              ].join(' ')}
            >
              <Ic className="w-4 h-4" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ConversionProgress({ progress, status }: { progress: ConvertProgress | null; status: string }) {
  if (!progress && !status) return null;
  const label = progress
    ? progress.stage === 'loading' ? 'Loading ffmpeg…' : 'Extracting audio…'
    : status;
  const value = progress ? Math.round(progress.ratio * 100) : undefined;

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs text-white/50">
        <span>{label}</span>
        {value !== undefined && <span>{value}%</span>}
      </div>
      <ProgressBar
        value={value}
        isIndeterminate={value === undefined}
        aria-label={label}
        className="w-full"
      >
        <ProgressBarTrack>
          <ProgressBarFill />
        </ProgressBarTrack>
      </ProgressBar>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  existingSoundIds: string[];
  onAddBuiltin: (soundId: string) => Promise<void>;
  onAddCustom: (file: File, name: string, color: string, icon: string) => Promise<void>;
  onClose: () => void;
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function AddSoundModal({ existingSoundIds, onAddBuiltin, onAddCustom, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [convertProgress, setConvertProgress] = useState<ConvertProgress | null>(null);

  // Upload tab
  const [file, setFile] = useState<File | null>(null);
  const [customName, setCustomName] = useState('');
  const [customColor, setCustomColor] = useState('#f97316');
  const [customIcon, setCustomIcon] = useState('Volume2');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // YouTube tab
  const [ytUrl, setYtUrl] = useState('');
  const [ytInfo, setYtInfo] = useState<{ title: string; thumbnail: string | null } | null>(null);
  const [ytInfoLoading, setYtInfoLoading] = useState(false);
  const [ytName, setYtName] = useState('');
  const [ytColor, setYtColor] = useState('#f97316');
  const [ytIcon, setYtIcon] = useState('Music');
  const [ytError, setYtError] = useState('');

  // ---- Built-in ----
  const handleAddBuiltin = async (soundId: string) => {
    setLoading(true);
    await onAddBuiltin(soundId);
    setLoading(false);
    onClose();
  };

  // ---- Upload ----
  const applyFile = (f: File) => {
    if (!isAcceptableFile(f)) return;
    setFile(f);
    if (!customName) setCustomName(f.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '));
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !customName.trim()) return;
    setLoading(true);
    setConvertProgress(null);
    setStatusMsg('');
    try {
      let finalFile = file;
      if (isVideoFile(file)) {
        setStatusMsg('Extracting audio…');
        finalFile = await extractAudioFromVideo(file, (p) => setConvertProgress(p));
        setStatusMsg('Uploading…');
      } else {
        setStatusMsg('Uploading…');
      }
      await onAddCustom(finalFile, customName.trim(), customColor, customIcon);
      onClose();
    } catch (err) {
      console.error(err);
      setStatusMsg('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
      setConvertProgress(null);
    }
  };

  // ---- YouTube ----
  const fetchYtInfo = async () => {
    if (!isYouTubeUrl(ytUrl)) { setYtError('Please enter a valid YouTube URL'); return; }
    setYtError('');
    setYtInfoLoading(true);
    setYtInfo(null);
    try {
      const res = await fetch(`${YOUTUBE_SERVER}/api/youtube/info?url=${encodeURIComponent(ytUrl)}`);
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`); }
      const data = await res.json() as { title: string; thumbnail: string | null };
      setYtInfo(data);
      if (!ytName) setYtName(data.title);
    } catch (err) {
      setYtError(err instanceof Error ? err.message : 'Failed to fetch video info');
    } finally {
      setYtInfoLoading(false);
    }
  };

  const handleYouTubeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ytUrl || !ytName.trim()) return;
    setLoading(true);
    setStatusMsg('Downloading audio from YouTube…');
    setConvertProgress(null);
    try {
      const audioUrl = `${YOUTUBE_SERVER}/api/youtube/audio?url=${encodeURIComponent(ytUrl)}&title=${encodeURIComponent(ytName.trim())}`;
      const res = await fetch(audioUrl);
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`); }
      const contentLength = Number(res.headers.get('content-length') ?? 0);
      const reader = res.body!.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (contentLength > 0) setConvertProgress({ stage: 'converting', ratio: received / contentLength });
      }
      const blob = new Blob(chunks, { type: 'audio/mpeg' });
      const audioFile = new File([blob], `${ytName.trim()}.mp3`, { type: 'audio/mpeg' });
      setStatusMsg('Uploading…');
      await onAddCustom(audioFile, ytName.trim(), ytColor, ytIcon);
      onClose();
    } catch (err) {
      console.error(err);
      setYtError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setLoading(false);
      setConvertProgress(null);
      setStatusMsg('');
    }
  };

  // ---------------------------------------------------------------------------
  return (
    <Modal
      isOpen
      onOpenChange={(open) => !open && !loading && onClose()}
      isDismissable={!loading}
    >
      <ModalBackdrop />
      <ModalContainer>
        <ModalDialog className="bg-[#111113] border border-white/10 max-w-md w-full rounded-2xl">

          {/* Header */}
          <ModalHeader className="px-5 pt-5 pb-0 flex items-center justify-between">
            <ModalHeading className="text-base font-semibold text-white">Add Sound</ModalHeading>
            <ModalCloseTrigger asChild>
              <Button isIconOnly variant="ghost" size="sm" isDisabled={loading} aria-label="Close">
                <Icons.X className="w-4 h-4" />
              </Button>
            </ModalCloseTrigger>
          </ModalHeader>

          {/* Body */}
          <ModalBody className="px-5 py-4 overflow-y-auto max-h-[70vh]">
            <Tabs defaultSelectedKey="builtin" className="w-full">
              <TabList className="mb-4">
                <Tab id="builtin">
                  <Icons.Music className="w-3.5 h-3.5 mr-1.5 inline" />
                  Library
                </Tab>
                <Tab id="upload">
                  <Icons.Upload className="w-3.5 h-3.5 mr-1.5 inline" />
                  Upload / MOV
                </Tab>
                <Tab id="youtube">
                  <Icons.Youtube className="w-3.5 h-3.5 mr-1.5 inline" />
                  YouTube
                </Tab>
              </TabList>

              {/* ---- Library ---- */}
              <TabPanel id="builtin">
                <div className="grid grid-cols-2 gap-2">
                  {SOUNDS.map((sound) => {
                    const alreadyAdded = existingSoundIds.includes(sound.id);
                    const Icon = ICONS_MAP[sound.icon ?? 'Volume2'] ?? Icons.Volume2;
                    return (
                      <button
                        key={sound.id}
                        onClick={() => !alreadyAdded && handleAddBuiltin(sound.id)}
                        disabled={alreadyAdded || loading}
                        className={[
                          'flex items-center gap-3 p-3 rounded-xl border text-left transition',
                          alreadyAdded
                            ? 'border-white/5 bg-white/[0.02] opacity-40 cursor-not-allowed'
                            : 'border-white/10 bg-white/[0.04] hover:border-white/25 hover:bg-white/[0.08] cursor-pointer',
                        ].join(' ')}
                      >
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
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
              </TabPanel>

              {/* ---- Upload / MOV ---- */}
              <TabPanel id="upload">
                <form onSubmit={handleUploadSubmit} className="space-y-4">
                  {/* Drop zone */}
                  <div
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) applyFile(f); }}
                    onClick={() => !loading && fileInputRef.current?.click()}
                    className={[
                      'border-2 border-dashed rounded-xl p-6 text-center transition',
                      loading ? 'border-white/10 cursor-not-allowed opacity-60' : 'border-white/15 cursor-pointer hover:border-orange-500/50 hover:bg-orange-500/5',
                    ].join(' ')}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="audio/*,video/*,.mp3,.mp4,.wav,.ogg,.webm,.m4a,.mov,.mkv,.avi,.flv"
                      className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) applyFile(f); }}
                    />
                    {file ? (
                      <div className="flex items-center justify-center gap-2 text-sm text-white/80">
                        {isVideoFile(file) ? <Icons.FileVideo className="w-5 h-5 text-orange-400" /> : <Icons.FileAudio className="w-5 h-5 text-orange-400" />}
                        <span className="truncate max-w-xs">{file.name}</span>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setFile(null); setStatusMsg(''); }}
                          className="text-white/30 hover:text-white/70"
                          disabled={loading}
                        >
                          <Icons.X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <Icons.Upload className="w-8 h-8 text-white/20 mx-auto mb-2" />
                        <p className="text-sm text-white/50">Drop a file here, or click to browse</p>
                        <p className="text-xs text-white/25 mt-1">Audio: MP3, WAV, OGG, M4A · Video: MOV, MP4, MKV, WebM</p>
                        <p className="text-xs text-white/20 mt-0.5">Video files will have their audio extracted automatically</p>
                      </>
                    )}
                  </div>

                  {loading && <ConversionProgress progress={convertProgress} status={statusMsg} />}

                  {/* Name */}
                  <TextFieldRoot fullWidth>
                    <TextField
                      value={customName}
                      onChange={setCustomName}
                      isRequired
                      isDisabled={loading}
                      label="Name"
                      placeholder="My Sound"
                    >
                      <Input />
                    </TextField>
                  </TextFieldRoot>

                  <ColorPicker value={customColor} onChange={setCustomColor} disabled={loading} />
                  <IconPicker value={customIcon} onChange={setCustomIcon} disabled={loading} />

                  <Button
                    type="submit"
                    isDisabled={!file || !customName.trim() || loading}
                    isPending={loading}
                    color="warning"
                    variant="flat"
                    fullWidth
                    className="font-semibold"
                  >
                    {loading ? 'Processing…' : 'Add to Board'}
                  </Button>
                </form>
              </TabPanel>

              {/* ---- YouTube ---- */}
              <TabPanel id="youtube">
                <form onSubmit={handleYouTubeSubmit} className="space-y-4">
                  <p className="text-xs text-white/40 leading-relaxed">
                    Paste a YouTube URL — the audio will be downloaded and added to your board.
                    Requires the local proxy server (<code className="text-white/60">npm run server</code>).
                  </p>

                  {/* URL row */}
                  <div className="flex gap-2">
                    <TextFieldRoot fullWidth>
                      <TextField
                        value={ytUrl}
                        onChange={(v) => { setYtUrl(v); setYtInfo(null); setYtError(''); }}
                        isDisabled={loading}
                        label="YouTube URL"
                        placeholder="https://www.youtube.com/watch?v=…"
                      >
                        <Input />
                      </TextField>
                    </TextFieldRoot>
                    <Button
                      type="button"
                      onPress={fetchYtInfo}
                      isDisabled={!ytUrl || ytInfoLoading || loading}
                      isPending={ytInfoLoading}
                      variant="flat"
                      isIconOnly
                      className="self-end mb-0.5"
                      aria-label="Fetch video info"
                    >
                      <Icons.Search className="w-4 h-4" />
                    </Button>
                  </div>

                  {ytError && <p className="text-xs text-red-400">{ytError}</p>}

                  {/* Video preview */}
                  {ytInfo && (
                    <div className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.04] border border-white/10">
                      {ytInfo.thumbnail && (
                        <img src={ytInfo.thumbnail} alt="thumbnail" className="w-16 h-11 object-cover rounded-lg shrink-0" />
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-white truncate">{ytInfo.title}</p>
                        <p className="text-xs text-white/40 mt-0.5 flex items-center gap-1">
                          <Icons.CheckCircle className="w-3 h-3 text-green-400" />
                          Ready to download
                        </p>
                      </div>
                    </div>
                  )}

                  {loading && <ConversionProgress progress={convertProgress} status={statusMsg} />}

                  {/* Name */}
                  <TextFieldRoot fullWidth>
                    <TextField
                      value={ytName}
                      onChange={setYtName}
                      isRequired
                      isDisabled={loading}
                      label="Name"
                      placeholder="Sound name"
                    >
                      <Input />
                    </TextField>
                  </TextFieldRoot>

                  <ColorPicker value={ytColor} onChange={setYtColor} disabled={loading} />
                  <IconPicker value={ytIcon} onChange={setYtIcon} disabled={loading} />

                  <Button
                    type="submit"
                    isDisabled={!ytUrl || !ytName.trim() || loading}
                    isPending={loading}
                    color="danger"
                    variant="flat"
                    fullWidth
                    className="font-semibold"
                    startContent={!loading && <Icons.Youtube className="w-4 h-4" />}
                  >
                    {loading ? 'Processing…' : 'Download & Add'}
                  </Button>
                </form>
              </TabPanel>
            </Tabs>
          </ModalBody>

          <ModalFooter className="px-5 pb-5 pt-0" />
        </ModalDialog>
      </ModalContainer>
    </Modal>
  );
}
