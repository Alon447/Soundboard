/**
 * Lightweight dev-only proxy server for YouTube audio extraction.
 *
 * Endpoints:
 *   GET /api/youtube/info?url=<ytUrl>   → { title, duration, thumbnail }
 *   GET /api/youtube/audio?url=<ytUrl>  → audio/mpeg stream (yt-dlp → ffmpeg pipe)
 *
 * Requires yt-dlp and ffmpeg to be installed on the host machine.
 * yt-dlp:  https://github.com/yt-dlp/yt-dlp#installation
 * ffmpeg:  https://ffmpeg.org/download.html
 */

import express from 'express';
import cors from 'cors';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const app = express();
const PORT = 3001;

// Allow requests from the Vite dev server
app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }));

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function isValidYouTubeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      ['www.youtube.com', 'youtube.com', 'youtu.be', 'm.youtube.com'].includes(parsed.hostname) &&
      // Basic sanity: only allow watch / short / embed URLs
      /^(\/watch|\/shorts\/|\/embed\/|\/v\/|\/)/.test(parsed.pathname) ||
      parsed.hostname === 'youtu.be'
    );
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------
// GET /api/youtube/info
// --------------------------------------------------------------------------
app.get('/api/youtube/info', async (req, res) => {
  const url = String(req.query.url ?? '');

  if (!url || !isValidYouTubeUrl(url)) {
    res.status(400).json({ error: 'Invalid or missing YouTube URL' });
    return;
  }

  try {
    const { stdout } = await execFileAsync('yt-dlp', [
      '--no-playlist',
      '--dump-json',
      '--no-download',
      url,
    ]);

    const info = JSON.parse(stdout);
    res.json({
      title: info.title ?? 'Unknown',
      duration: info.duration ?? 0,
      thumbnail: info.thumbnail ?? null,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[yt-dlp info error]', msg);
    res.status(500).json({ error: 'Failed to fetch video info. Is yt-dlp installed?' });
  }
});

// --------------------------------------------------------------------------
// GET /api/youtube/audio
// --------------------------------------------------------------------------
app.get('/api/youtube/audio', (req, res) => {
  const url = String(req.query.url ?? '');
  const title = String(req.query.title ?? 'audio');

  if (!url || !isValidYouTubeUrl(url)) {
    res.status(400).json({ error: 'Invalid or missing YouTube URL' });
    return;
  }

  // Sanitise filename for Content-Disposition
  const safeTitle = title.replace(/[^\w\s-]/g, '').trim().slice(0, 80) || 'audio';

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.mp3"`);
  res.setHeader('Transfer-Encoding', 'chunked');

  // yt-dlp writes the best audio stream to stdout (-o -)
  const ytdlp = spawn('yt-dlp', [
    '--no-playlist',
    '-f', 'bestaudio',
    '-o', '-',          // pipe to stdout
    '--quiet',
    url,
  ]);

  // ffmpeg reads from stdin, encodes to MP3, writes to stdout
  const ffmpegProc = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', 'pipe:0',     // read from stdin
    '-vn',
    '-acodec', 'libmp3lame',
    '-q:a', '2',        // VBR ~190 kbps
    '-f', 'mp3',
    'pipe:1',           // write to stdout
  ]);

  ytdlp.stdout.pipe(ffmpegProc.stdin);
  ffmpegProc.stdout.pipe(res);

  // Error handling
  ytdlp.stderr.on('data', (d: Buffer) => console.error('[yt-dlp]', d.toString().trim()));
  ffmpegProc.stderr.on('data', (d: Buffer) => console.error('[ffmpeg]', d.toString().trim()));

  ytdlp.on('error', (err) => {
    console.error('[yt-dlp spawn error]', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'yt-dlp not found. Please install it.' });
  });

  ffmpegProc.on('error', (err) => {
    console.error('[ffmpeg spawn error]', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'ffmpeg not found. Please install it.' });
  });

  ffmpegProc.on('close', (code) => {
    if (code !== 0) console.error(`[ffmpeg] exited with code ${code}`);
  });

  // If the client disconnects, kill both child processes
  req.on('close', () => {
    ytdlp.kill('SIGKILL');
    ffmpegProc.kill('SIGKILL');
  });
});

// --------------------------------------------------------------------------
// Start
// --------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[soundboard-server] listening on http://localhost:${PORT}`);
  console.log('  Requires: yt-dlp  →  https://github.com/yt-dlp/yt-dlp#installation');
  console.log('  Requires: ffmpeg   →  https://ffmpeg.org/download.html');
});
