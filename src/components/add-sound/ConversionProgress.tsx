import { ProgressBar, ProgressBarFill, ProgressBarTrack } from '@heroui/react';
import type { ConvertProgress } from '@/lib/ffmpegConvert';

type ConversionProgressProps = {
	progress: ConvertProgress | null;
	status: string;
};

export default function ConversionProgress({ progress, status }: ConversionProgressProps) {
	if (!progress && !status) return null;

	const label = progress ? (progress.stage === 'loading' ? 'Loading ffmpeg…' : 'Extracting audio…') : status;
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
