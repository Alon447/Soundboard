import * as Icons from 'lucide-react';
import { ICON_OPTIONS, ICONS_MAP } from '@/components/add-sound/constants';

type IconPickerProps = {
	value: string;
	onChange: (icon: string) => void;
	disabled?: boolean;
};

export default function IconPicker({ value, onChange, disabled = false }: IconPickerProps) {
	return (
		<div>
			<p className="mb-2 text-xs text-white/50">Icon</p>
			<div className="flex flex-wrap gap-2">
				{ICON_OPTIONS.map((name) => {
					const Icon = ICONS_MAP[name] ?? Icons.Volume2;

					return (
						<button
							key={name}
							type="button"
							onClick={() => onChange(name)}
							disabled={disabled}
							className={[
								'flex h-9 w-9 items-center justify-center rounded-lg transition disabled:opacity-50',
								value === name ? 'bg-white/20 text-white' : 'bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/80',
							].join(' ')}
						>
							<Icon className="h-4 w-4" />
						</button>
					);
				})}
			</div>
		</div>
	);
}
