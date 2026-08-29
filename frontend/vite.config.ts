import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { dirname } from 'node:path';

// Aliased rather than deep-imported: @ffmpeg/core-mt's exports map exposes only the package
// root and ./wasm, and never the worker.
const ffmpegCore = dirname(fileURLToPath(import.meta.resolve('@ffmpeg/core-mt')));

export default defineConfig({
	plugins: [
		// Tailwind v4 Vite plugin — replaces postcss plugin + autoprefixer
		tailwindcss(),
		react(),
		// COOP/COEP headers — required for SharedArrayBuffer (ffmpeg.wasm)
		{
			name: 'cross-origin-isolation',
			configureServer(server) {
				server.middlewares.use((_req, res, next) => {
					res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
					res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
					next();
				});
			},
			configurePreviewServer(server) {
				server.middlewares.use((_req, res, next) => {
					res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
					res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
					next();
				});
			},
		},
	],
	resolve: {
		alias: {
			'@': fileURLToPath(new URL('./src', import.meta.url)),
			'ffmpeg-core': ffmpegCore,
		},
	},
	server: {
		port: 3000,
		proxy: {
			// Both go to our own backend — there is no separate auth process.
			// Same-origin in dev too, so COOP/COEP and the audio fetch behave as in production.
			'/api': { target: 'http://127.0.0.1:3001', changeOrigin: true },
			'/auth': { target: 'http://127.0.0.1:3001', changeOrigin: true },
		},
	},
	optimizeDeps: {
		exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/core', '@ffmpeg/core-mt'],
	},
	build: {
		chunkSizeWarningLimit: 1500,
		// Small enough to be inlined by default, and a data: URL cannot back a Worker.
		assetsInlineLimit: (file: string) => (file.includes('ffmpeg-core.worker') ? false : undefined),
	},
});
