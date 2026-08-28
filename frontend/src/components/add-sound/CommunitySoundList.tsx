import * as Icons from 'lucide-react';
import type { SharedSound } from '@/lib/supabase';
import { ICONS_MAP } from '@/components/add-sound/constants';

type CommunitySoundListProps = {
	sharedSounds: SharedSound[];
	loading: boolean;
	onAddShared: (shared: SharedSound) => void;
};

export default function CommunitySoundList({ sharedSounds, loading, onAddShared }: CommunitySoundListProps) {
	if (!loading && sharedSounds.length === 0) {
		return <p className="py-8 text-center text-sm text-white/40">No shared sounds yet. Upload one to get started!</p>;
	}

	return (
		<div className="grid grid-cols-2 gap-2">
			{sharedSounds.map((shared) => {
				const Icon = ICONS_MAP[shared.icon] ?? Icons.Volume2;

				return (
					<button
						key={shared.id}
						type="button"
						onClick={() => onAddShared(shared)}
						disabled={loading}
						className="flex cursor-pointer items-center gap-3 rounded-xl border border-white/10 bg-white/4 p-3 text-left transition hover:border-white/25 hover:bg-white/8 disabled:cursor-not-allowed disabled:opacity-40"
					>
						<div
							className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
							style={{ backgroundColor: `${shared.color}25` }}
						>
							<Icon
								className="h-4 w-4"
								style={{ color: shared.color }}
							/>
						</div>

						<div className="min-w-0">
							<p className="truncate text-sm font-medium text-white">{shared.name}</p>
							<p className="truncate text-xs text-white/35">by {shared.owner_name}</p>
						</div>
					</button>
				);
			})}
		</div>
	);
}
