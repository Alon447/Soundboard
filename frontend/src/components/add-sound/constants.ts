import * as Icons from 'lucide-react';

export const ICON_OPTIONS = ['Volume2', 'Music', 'Zap', 'Laugh', 'Frown', 'AlertTriangle', 'Box', 'Copy', 'Trees', 'Star', 'Heart', 'Flame'];

export const COLOR_OPTIONS = [
	'#f97316',
	'#ef4444',
	'#eab308',
	'#22c55e',
	'#3b82f6',
	'#8b5cf6',
	'#f43f5e',
	'#84cc16',
	'#06b6d4',
	'#ec4899',
	'#a855f7',
	'#ffffff',
];

export const ICONS_MAP = Icons as unknown as Record<string, Icons.LucideIcon>;
export const YOUTUBE_SERVER = 'http://localhost:3001';
export const VIDEO_EXTENSIONS = /\.(mov|mp4|mkv|webm|avi|flv|m4v|wmv)$/i;
export const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/i;
