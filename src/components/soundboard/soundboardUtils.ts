import * as Icons from 'lucide-react';

const ICONS = Icons as unknown as Record<string, Icons.LucideIcon>;
export const DEFAULT_COLOR = '#f97316';

export function assetPath(path: string): string {
	if (!path) return '';
	if (path.startsWith('/') || path.startsWith('http://') || path.startsWith('https://')) {
		return path;
	}
	return `/${path.replace(/^\/+/, '')}`;
}

export function isSynth(path: string): boolean {
	return path.startsWith('synth:');
}

export function getIcon(name: string | null | undefined): Icons.LucideIcon {
	return (name && ICONS[name]) || Icons.Music;
}
