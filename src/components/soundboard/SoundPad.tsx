import * as Icons from 'lucide-react';
import type { BoardSound } from '@/lib/useUserSounds';
import VolumePopover from '@/components/soundboard/VolumePopover';
import { assetPath, DEFAULT_COLOR, getIcon } from '@/components/soundboard/soundboardUtils';

type SoundPadProps = {
	sound: BoardSound;
	index: number;
	totalSounds: number;
	editMode: boolean;
	isActive: boolean;
	keyHint?: string;
	isVolumeOpen: boolean;
	onTrigger: (sound: BoardSound) => void;
	onRemove: (dbId: string) => void;
	onMove: (dbId: string, direction: 'left' | 'right') => void;
	onUpdateGain: (dbId: string, gain: number) => void;
	onToggleVolumePopover: (dbId: string) => void;
	onCloseVolumePopover: () => void;
};

export default function SoundPad({
	sound,
	index,
	totalSounds,
	editMode,
	isActive,
	keyHint,
	isVolumeOpen,
	onTrigger,
	onRemove,
	onMove,
	onUpdateGain,
	onToggleVolumePopover,
	onCloseVolumePopover,
}: SoundPadProps) {
	const Icon = getIcon(sound.icon);
	const hasImage = Boolean(sound.image_path);
	const color = sound.color ?? DEFAULT_COLOR;

	return (
		<div className="group relative">
			{isVolumeOpen && (
				<VolumePopover
					dbId={sound.dbId}
					gain={sound.gain}
					color={color}
					onUpdate={onUpdateGain}
					onClose={onCloseVolumePopover}
				/>
			)}

			<button
				type="button"
				onPointerDown={() => !editMode && onTrigger(sound)}
				className={[
					'relative aspect-square w-full select-none overflow-hidden rounded-2xl border transition-all duration-150 touch-none',
					editMode
						? 'cursor-default border-white/20 opacity-90'
						: isActive
							? 'scale-95 border-white/40'
							: 'border-white/10 hover:scale-[1.03] hover:border-white/30',
				].join(' ')}
				style={isActive && !editMode ? { boxShadow: `0 0 24px ${color}80, inset 0 0 16px ${color}40` } : undefined}
			>
				{hasImage ? (
					<img
						src={assetPath(sound.image_path ?? '')}
						alt={sound.name}
						className="absolute inset-0 h-full w-full object-cover"
					/>
				) : (
					<div className="absolute inset-0 bg-linear-to-b from-white/6 to-white/2" />
				)}

				<div className="absolute inset-0 bg-black/30" />

				{isActive && !editMode && (
					<div
						className="absolute inset-0"
						style={{ background: `radial-gradient(circle at center, ${color}40, transparent 70%)` }}
					/>
				)}

				<div className="relative flex h-full flex-col items-center justify-center gap-2 p-2">
					{!hasImage && (
						<Icon
							className="h-7 w-7"
							style={{ color: isActive ? color : '#ffffff80' }}
						/>
					)}
					<span className="w-full truncate text-center text-xs font-semibold text-white drop-shadow-lg">{sound.name}</span>
				</div>

				{keyHint && !editMode && <span className="absolute top-1.5 right-2 font-mono text-[10px] text-white/40">{keyHint}</span>}

				<div
					className="absolute top-1.5 left-2 h-2.5 w-2.5 rounded-full"
					style={{ backgroundColor: color }}
				/>

				{!editMode && sound.gain !== 1 && (
					<span className="absolute right-2 bottom-1.5 font-mono text-[9px] text-white/30">{Math.round(sound.gain * 100)}%</span>
				)}
			</button>

			{editMode && (
				<div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-between pt-1.5 pb-1.5">
					<div className="pointer-events-auto flex w-full justify-center">
						<button
							type="button"
							onClick={() => onToggleVolumePopover(sound.dbId)}
							className={[
								'flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium transition',
								isVolumeOpen ? 'bg-white/25 text-white' : 'bg-black/60 text-white/60 hover:bg-black/80 hover:text-white',
							].join(' ')}
						>
							<Icons.Volume2 className="h-3 w-3" />
							{Math.round(sound.gain * 100)}%
						</button>
					</div>

					<div className="pointer-events-auto flex items-center gap-1">
						<button
							type="button"
							onClick={() => onMove(sound.dbId, 'left')}
							disabled={index === 0}
							className="flex h-6 w-6 items-center justify-center rounded-md bg-black/70 text-white/60 transition hover:text-white disabled:opacity-20"
						>
							<Icons.ChevronLeft className="h-3.5 w-3.5" />
						</button>

						<button
							type="button"
							onClick={() => onRemove(sound.dbId)}
							className="flex h-6 w-6 items-center justify-center rounded-md bg-red-500/80 text-white transition hover:bg-red-500"
						>
							<Icons.Trash2 className="h-3.5 w-3.5" />
						</button>

						<button
							type="button"
							onClick={() => onMove(sound.dbId, 'right')}
							disabled={index === totalSounds - 1}
							className="flex h-6 w-6 items-center justify-center rounded-md bg-black/70 text-white/60 transition hover:text-white disabled:opacity-20"
						>
							<Icons.ChevronRight className="h-3.5 w-3.5" />
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
