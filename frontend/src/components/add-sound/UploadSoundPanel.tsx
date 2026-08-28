import * as Icons from 'lucide-react';
import { Button, Input } from '@heroui/react';
import type { ConvertProgress } from '@/lib/ffmpegConvert';
import ColorPicker from '@/components/add-sound/ColorPicker';
import ConversionProgress from '@/components/add-sound/ConversionProgress';
import IconPicker from '@/components/add-sound/IconPicker';
import { isVideoFile } from '@/components/add-sound/utils';

type UploadSoundPanelProps = {
	loading: boolean;
	file: File | null;
	customName: string;
	customColor: string;
	customIcon: string;
	statusMsg: string;
	convertProgress: ConvertProgress | null;
	onSubmit: (event: React.FormEvent) => void;
	onFileDrop: (file: File) => void;
	onFileBrowse: () => void;
	onFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void;
	onFileClear: () => void;
	onNameChange: (value: string) => void;
	onColorChange: (value: string) => void;
	onIconChange: (value: string) => void;
	inputRef: React.RefObject<HTMLInputElement | null>;
};

export default function UploadSoundPanel({
	loading,
	file,
	customName,
	customColor,
	customIcon,
	statusMsg,
	convertProgress,
	onSubmit,
	onFileDrop,
	onFileBrowse,
	onFileSelect,
	onFileClear,
	onNameChange,
	onColorChange,
	onIconChange,
	inputRef,
}: UploadSoundPanelProps) {
	return (
		<form
			onSubmit={onSubmit}
			className="space-y-4"
		>
			<div
				onDragOver={(event) => event.preventDefault()}
				onDrop={(event) => {
					event.preventDefault();
					const droppedFile = event.dataTransfer.files[0];
					if (droppedFile) onFileDrop(droppedFile);
				}}
				onClick={() => !loading && onFileBrowse()}
				className={[
					'rounded-xl border-2 border-dashed p-6 text-center transition',
					loading
						? 'cursor-not-allowed border-white/10 opacity-60'
						: 'cursor-pointer border-white/15 hover:border-orange-500/50 hover:bg-orange-500/5',
				].join(' ')}
			>
				<input
					ref={inputRef}
					type="file"
					accept="audio/*,video/*,.mp3,.mp4,.wav,.ogg,.webm,.m4a,.mov,.mkv,.avi,.flv"
					className="hidden"
					onChange={onFileSelect}
				/>

				{file ? (
					<div className="flex items-center justify-center gap-2 text-sm text-white/80">
						{isVideoFile(file) ? (
							<Icons.FileVideo className="h-5 w-5 text-orange-400" />
						) : (
							<Icons.FileAudio className="h-5 w-5 text-orange-400" />
						)}
						<span className="max-w-xs truncate">{file.name}</span>
						<button
							type="button"
							onClick={(event) => {
								event.stopPropagation();
								onFileClear();
							}}
							className="text-white/30 hover:text-white/70"
							disabled={loading}
						>
							<Icons.X className="h-4 w-4" />
						</button>
					</div>
				) : (
					<>
						<Icons.Upload className="mx-auto mb-2 h-8 w-8 text-white/20" />
						<p className="text-sm text-white/50">Drop a file here, or click to browse</p>
						<p className="mt-1 text-xs text-white/25">Audio: MP3, WAV, OGG, M4A · Video: MOV, MP4, MKV, WebM</p>
						<p className="mt-0.5 text-xs text-white/20">Video files will have their audio extracted automatically</p>
					</>
				)}
			</div>

			{loading && (
				<ConversionProgress
					progress={convertProgress}
					status={statusMsg}
				/>
			)}

			<label className="block space-y-1.5">
				<span className="text-xs text-white/50">Name</span>
				<Input
					value={customName}
					onChange={(event) => onNameChange(event.target.value)}
					required
					disabled={loading}
					placeholder="My Sound"
					variant="secondary"
					className="sb-input"
					fullWidth
				/>
			</label>

			<ColorPicker
				value={customColor}
				onChange={onColorChange}
				disabled={loading}
			/>
			<IconPicker
				value={customIcon}
				onChange={onIconChange}
				disabled={loading}
			/>

			<Button
				type="submit"
				isDisabled={!file || !customName.trim() || loading}
				isPending={loading}
				variant="primary"
				fullWidth
				className="sb-button font-semibold"
			>
				{loading ? 'Processing…' : 'Add to Board'}
			</Button>
		</form>
	);
}
