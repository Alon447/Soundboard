import * as Icons from 'lucide-react';
import { SOUNDS } from '@/lib/sounds';
import { ICONS_MAP } from '@/components/add-sound/constants';

type BuiltinSoundListProps = {
	existingSoundIds: string[];
	loading: boolean;
	onAddBuiltin: (soundId: string) => void;
};

export default function BuiltinSoundList({ existingSoundIds, loading, onAddBuiltin }: BuiltinSoundListProps) {
	return (
		<div className="grid grid-cols-2 gap-2">
			{SOUNDS.map((sound) => {
				const alreadyAdded = existingSoundIds.includes(sound.id);
				const Icon = ICONS_MAP[sound.icon ?? 'Volume2'] ?? Icons.Volume2;

				return (
					<button
						key={sound.id}
						type="button"
						onClick={() => !alreadyAdded && onAddBuiltin(sound.id)}
						disabled={alreadyAdded || loading}
						className={[
							'flex items-center gap-3 rounded-xl border p-3 text-left transition',
							alreadyAdded
								? 'cursor-not-allowed border-white/5 bg-white/2 opacity-40'
								: 'cursor-pointer border-white/10 bg-white/4 hover:border-white/25 hover:bg-white/8',
						].join(' ')}
					>
						<div
							className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
							style={{ backgroundColor: `${sound.color ?? '#f97316'}25` }}
						>
							<Icon
								className="h-4 w-4"
								style={{ color: sound.color ?? '#f97316' }}
							/>
						</div>

						<div className="min-w-0">
							<p className="truncate text-sm font-medium text-white">{sound.name}</p>
							{alreadyAdded && <p className="text-xs text-white/30">Added</p>}
						</div>
					</button>
				);
			})}
		</div>
	);
}
