import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

// Singleton instance — loaded once, reused across calls
let ffmpeg: FFmpeg | null = null;
let loadPromise: Promise<boolean> | null = null;

async function getFFmpeg(onProgress?: (ratio: number) => void): Promise<FFmpeg> {
  if (ffmpeg?.loaded) return ffmpeg;

  if (!loadPromise) {
    ffmpeg = new FFmpeg();

    if (onProgress) {
      ffmpeg.on('progress', ({ progress }) => onProgress(Math.min(progress, 1)));
    }

    // Load the multi-threaded core from the npm package files
    // We use toBlobURL so the WASM assets are served from the same origin,
    // which is required when COEP: require-corp is active.
    const baseURL = 'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm';

    loadPromise = ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'text/javascript'),
    });
  }

  await loadPromise;
  return ffmpeg!;
}

export type ConvertProgress = {
  stage: 'loading' | 'converting';
  ratio: number; // 0–1
};

/**
 * Extracts the audio track from any video file (MOV, MP4, MKV, WebM, etc.)
 * and returns an MP4/AAC blob ready for upload or playback.
 *
 * @param file     The video file to extract audio from.
 * @param onProgress  Optional progress callback.
 */
export async function extractAudioFromVideo(
  file: File,
  onProgress?: (p: ConvertProgress) => void,
): Promise<File> {
  const report = (stage: ConvertProgress['stage'], ratio: number) =>
    onProgress?.({ stage, ratio });

  report('loading', 0);

  const instance = await getFFmpeg((ratio) => {
    // Only emit loading progress while we haven't started converting yet
    report('loading', ratio);
  });

  report('loading', 1);

  // Write input into the in-memory FS
  const inputName = `input.${getExtension(file.name)}`;
  const outputName = 'output.mp3';

  instance.on('progress', ({ progress }) => report('converting', Math.min(progress, 1)));

  await instance.writeFile(inputName, await fetchFile(file));

  // Extract audio: copy the AAC stream if available, otherwise re-encode to AAC
  await instance.exec([
    '-i', inputName,
    '-vn',            // drop video
    '-acodec', 'libmp3lame',
    '-q:a', '2',      // VBR ~190 kbps — good quality
    outputName,
  ]);

  const data = await instance.readFile(outputName);

  // Clean up in-memory FS
  await instance.deleteFile(inputName).catch(() => undefined);
  await instance.deleteFile(outputName).catch(() => undefined);

  const blob = new Blob([data], { type: 'audio/mpeg' });
  const baseName = file.name.replace(/\.[^.]+$/, '');
  return new File([blob], `${baseName}.mp3`, { type: 'audio/mpeg' });
}

function getExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? 'bin';
}
