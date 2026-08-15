import * as Icons from 'lucide-react';
import { Button, Input } from '@heroui/react';
import type { ConvertProgress } from '@/lib/ffmpegConvert';
import ColorPicker from '@/components/add-sound/ColorPicker';
import ConversionProgress from '@/components/add-sound/ConversionProgress';
import IconPicker from '@/components/add-sound/IconPicker';

type YouTubeInfo = {
	title: string;
	thumbnail: string | null;
};

type YouTubeSoundPanelProps = {
	loading: boolean;
	ytUrl: string;
	ytName: string;
	ytColor: string;
	ytIcon: string;
	ytInfo: YouTubeInfo | null;
	ytInfoLoading: boolean;
	ytError: string;
	statusMsg: string;
	convertProgress: ConvertProgress | null;
	onSubmit: (event: React.FormEvent) => void;
	onFetchInfo: () => void;
	onUrlChange: (value: string) => void;
	onNameChange: (value: string) => void;
	onColorChange: (value: string) => void;
	onIconChange: (value: string) => void;
};

export default function YouTubeSoundPanel({
	loading,
	ytUrl,
	ytName,
	ytColor,
	ytIcon,
	ytInfo,
	ytInfoLoading,
	ytError,
	statusMsg,
	convertProgress,
	onSubmit,
	onFetchInfo,
	onUrlChange,
	onNameChange,
	onColorChange,
	onIconChange,
}: YouTubeSoundPanelProps) {
	return (
		<form
			onSubmit={onSubmit}
			className="space-y-4"
		>
			<p className="text-xs leading-relaxed text-white/40">
				Paste a YouTube URL — the audio will be downloaded and added to your board. Requires the local proxy server (
				<code className="text-white/60">npm run server</code>).
			</p>

			<div className="flex gap-2">
				<label className="flex-1 space-y-1.5">
					<span className="text-xs text-white/50">YouTube URL</span>
					<Input
						value={ytUrl}
						onChange={(event) => onUrlChange(event.target.value)}
						disabled={loading}
						placeholder="https://www.youtube.com/watch?v=…"
						variant="secondary"
						className="sb-input"
						fullWidth
					/>
				</label>

				<Button
					type="button"
					onPress={onFetchInfo}
					isDisabled={!ytUrl || ytInfoLoading || loading}
					isPending={ytInfoLoading}
					variant="secondary"
					isIconOnly
					className="sb-button self-end"
					aria-label="Fetch video info"
				>
					<Icons.Search className="h-4 w-4" />
				</Button>
			</div>

			{ytError && <p className="text-xs text-red-400">{ytError}</p>}

			{ytInfo && (
				<div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/4 p-3">
					{ytInfo.thumbnail && (
						<img
							src={ytInfo.thumbnail}
							alt="thumbnail"
							className="h-11 w-16 shrink-0 rounded-lg object-cover"
						/>
					)}
					<div className="min-w-0">
						<p className="truncate text-sm font-medium text-white">{ytInfo.title}</p>
						<p className="mt-0.5 flex items-center gap-1 text-xs text-white/40">
							<Icons.CheckCircle className="h-3 w-3 text-green-400" />
							Ready to download
						</p>
					</div>
				</div>
			)}

			{loading && (
				<ConversionProgress
					progress={convertProgress}
					status={statusMsg}
				/>
			)}

			<label className="block space-y-1.5">
				<span className="text-xs text-white/50">Name</span>
				<Input
					value={ytName}
					onChange={(event) => onNameChange(event.target.value)}
					required
					disabled={loading}
					placeholder="Sound name"
					variant="secondary"
					className="sb-input"
					fullWidth
				/>
			</label>

			<ColorPicker
				value={ytColor}
				onChange={onColorChange}
				disabled={loading}
			/>
			<IconPicker
				value={ytIcon}
				onChange={onIconChange}
				disabled={loading}
			/>

			<Button
				type="submit"
				isDisabled={!ytUrl || !ytName.trim() || loading}
				isPending={loading}
				variant="danger"
				fullWidth
				className="sb-button font-semibold"
			>
				{!loading && <Icons.Youtube className="h-4 w-4" />}
				{loading ? 'Processing…' : 'Download & Add'}
			</Button>
		</form>
	);
}
