import { COLOR_OPTIONS } from '@/components/add-sound/constants';

type ColorPickerProps = {
	value: string;
	onChange: (color: string) => void;
	disabled?: boolean;
};

export default function ColorPicker({ value, onChange, disabled = false }: ColorPickerProps) {
	return (
		<div>
			<p className="mb-2 text-xs text-white/50">Color</p>
			<div className="flex flex-wrap gap-2">
				{COLOR_OPTIONS.map((color) => (
					<button
						key={color}
						type="button"
						onClick={() => onChange(color)}
						disabled={disabled}
						className={[
							'h-7 w-7 rounded-full transition ring-offset-[#111113] disabled:opacity-50',
							value === color ? 'ring-2 ring-white ring-offset-2' : 'hover:scale-110',
						].join(' ')}
						style={{ backgroundColor: color }}
					/>
				))}
			</div>
		</div>
	);
}
