import { useEffect } from 'react';

type VolumePopoverProps = {
	dbId: string;
	gain: number;
	onUpdate: (dbId: string, gain: number) => void;
	onClose: () => void;
};

export default function VolumePopover({ dbId, gain, onUpdate, onClose }: VolumePopoverProps) {
	useEffect(() => {
		const id = setTimeout(() => {
			const handler = (event: MouseEvent) => {
				const element = document.getElementById(`vol-popover-${dbId}`);
				if (element && !element.contains(event.target as Node)) onClose();
			};

			document.addEventListener('mousedown', handler);
			return () => document.removeEventListener('mousedown', handler);
		}, 50);

		return () => clearTimeout(id);
	}, [dbId, onClose]);

	return (
		<div
			id={`vol-popover-${dbId}`}
			className="absolute bottom-full left-1/2 z-50 mb-2 flex w-40 -translate-x-1/2 flex-col gap-2.5 rounded-xl border border-white/15 bg-[#1c1c1f] p-3 shadow-2xl"
			onPointerDown={(event) => event.stopPropagation()}
		>
			<div className="flex gap-1">
				{[ 100, 400, 600, 800].map((value) => (
					<button
						key={value}
						type="button"
						onClick={() => onUpdate(dbId, value / 100)}
						className={[
							'flex-1 rounded-md py-1 text-[9px] transition',
							Math.round(gain * 100) === value ? 'bg-white/20 text-white' : 'bg-white/5 text-white/40 hover:bg-white/10',
						].join(' ')}
					>
						{value}%
					</button>
				))}
			</div>
		</div>
	);
}
