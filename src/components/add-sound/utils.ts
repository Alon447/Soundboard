import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from '@/components/add-sound/constants';

export function isVideoFile(file: File): boolean {
	return VIDEO_EXTENSIONS.test(file.name) || (file.type.startsWith('video/') && !file.type.startsWith('audio/'));
}

export function isAcceptableFile(file: File): boolean {
	return file.type.startsWith('audio/') || file.type.startsWith('video/') || VIDEO_EXTENSIONS.test(file.name) || AUDIO_EXTENSIONS.test(file.name);
}

export function isYouTubeUrl(value: string): boolean {
	try {
		const { hostname } = new URL(value);
		return ['www.youtube.com', 'youtube.com', 'youtu.be', 'm.youtube.com'].includes(hostname);
	} catch {
		return false;
	}
}
