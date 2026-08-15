import { useEffect, useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import { Button, Tab, TabList, TabPanel, Tabs } from '@heroui/react';
import { extractAudioFromVideo, type ConvertProgress } from '@/lib/ffmpegConvert';
import BuiltinSoundList from '@/components/add-sound/BuiltinSoundList';
import CommunitySoundList from '@/components/add-sound/CommunitySoundList';
import UploadSoundPanel from '@/components/add-sound/UploadSoundPanel';
import { isAcceptableFile, isVideoFile } from '@/components/add-sound/utils';
import { useSharedSounds } from '@/lib/useSharedSounds';
import type { SharedSound } from '@/lib/supabase';

type Props = {
	existingSoundIds: string[];
	onAddBuiltin: (soundId: string) => Promise<void>;
	onAddCustom: (file: File, name: string, color: string, icon: string) => Promise<void>;
	onAddShared: (shared: SharedSound) => Promise<void>;
	onClose: () => void;
};

export default function AddSoundModal({ existingSoundIds, onAddBuiltin, onAddCustom, onAddShared, onClose }: Props) {
	const [loading, setLoading] = useState(false);
	const [statusMsg, setStatusMsg] = useState('');
	const [convertProgress, setConvertProgress] = useState<ConvertProgress | null>(null);
	const { sharedSounds, loading: sharedLoading } = useSharedSounds();

	const [file, setFile] = useState<File | null>(null);
	const [customName, setCustomName] = useState('');
	const [customColor, setCustomColor] = useState('#f97316');
	const [customIcon, setCustomIcon] = useState('Volume2');
	const fileInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && !loading) onClose();
		};

		window.addEventListener('keydown', handleKeyDown);

		return () => {
			document.body.style.overflow = previousOverflow;
			window.removeEventListener('keydown', handleKeyDown);
		};
	}, [loading, onClose]);

	const handleAddBuiltin = async (soundId: string) => {
		setLoading(true);
		try {
			await onAddBuiltin(soundId);
			onClose();
		} finally {
			setLoading(false);
		}
	};

	const handleAddShared = async (shared: SharedSound) => {
		setLoading(true);
		try {
			await onAddShared(shared);
			onClose();
		} finally {
			setLoading(false);
		}
	};

	const applyFile = (nextFile: File) => {
		if (!isAcceptableFile(nextFile)) return;
		setFile(nextFile);
		if (!customName) setCustomName(nextFile.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '));
	};

	const handleUploadSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!file || !customName.trim()) return;
		setLoading(true);
		setConvertProgress(null);
		setStatusMsg('');

		try {
			let finalFile = file;
			if (isVideoFile(file)) {
				setStatusMsg('Extracting audio…');
				finalFile = await extractAudioFromVideo(file, (progress) => setConvertProgress(progress));
				setStatusMsg('Uploading…');
			} else {
				setStatusMsg('Uploading…');
			}

			await onAddCustom(finalFile, customName.trim(), customColor, customIcon);
			onClose();
		} catch (error) {
			console.error(error);
			setStatusMsg('Something went wrong. Please try again.');
		} finally {
			setLoading(false);
			setConvertProgress(null);
		}
	};

	return (
		<div
			className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6"
			role="dialog"
			aria-modal="true"
			aria-labelledby="add-sound-modal-title"
		>
			<button
				type="button"
				className="absolute inset-0 bg-black/72 backdrop-blur-sm"
				aria-label="Close add sound modal"
				onClick={() => {
					if (!loading) onClose();
				}}
			/>

			<div className="sb-modal-surface relative z-10 max-h-[min(720px,calc(100vh-2rem))] w-full max-w-xl overflow-hidden rounded-2xl border">
				<div className="flex items-center justify-between px-5 pt-5 pb-0">
					<h2
						id="add-sound-modal-title"
						className="text-base font-semibold text-white"
					>
						Add Sound
					</h2>
					<Button
						isIconOnly
						variant="ghost"
						size="sm"
						isDisabled={loading}
						aria-label="Close"
						className="sb-button"
						onPress={onClose}
					>
						<Icons.X className="w-4 h-4" />
					</Button>
				</div>

				<div className="max-h-[70vh] overflow-y-auto px-5 py-4">
					<Tabs
						defaultSelectedKey="builtin"
						className="sb-tabs w-full"
					>
						<TabList className="sb-tab-list mb-4">
							<Tab id="builtin">
								<Icons.Music className="w-3.5 h-3.5 mr-1.5 inline" />
								Library
							</Tab>
							<Tab id="upload">
								<Icons.Upload className="w-3.5 h-3.5 mr-1.5 inline" />
								Upload / MOV
							</Tab>
							<Tab id="community">
								<Icons.Users className="w-3.5 h-3.5 mr-1.5 inline" />
								Community
							</Tab>
						</TabList>

						<TabPanel id="builtin">
							<BuiltinSoundList
								existingSoundIds={existingSoundIds}
								loading={loading}
								onAddBuiltin={(soundId) => {
									void handleAddBuiltin(soundId);
								}}
							/>
						</TabPanel>

						<TabPanel id="upload">
							<UploadSoundPanel
								loading={loading}
								file={file}
								customName={customName}
								customColor={customColor}
								customIcon={customIcon}
								statusMsg={statusMsg}
								convertProgress={convertProgress}
								onSubmit={handleUploadSubmit}
								onFileDrop={applyFile}
								onFileBrowse={() => fileInputRef.current?.click()}
								onFileSelect={(event) => {
									const selectedFile = event.target.files?.[0];
									if (selectedFile) applyFile(selectedFile);
								}}
								onFileClear={() => {
									setFile(null);
									setStatusMsg('');
								}}
								onNameChange={setCustomName}
								onColorChange={setCustomColor}
								onIconChange={setCustomIcon}
								inputRef={fileInputRef}
							/>
						</TabPanel>

						<TabPanel id="community">
							<CommunitySoundList
								sharedSounds={sharedSounds}
								loading={loading || sharedLoading}
								onAddShared={(shared) => {
									void handleAddShared(shared);
								}}
							/>
						</TabPanel>
					</Tabs>
				</div>

				<div className="px-5 pb-5 pt-0" />
			</div>
		</div>
	);
}
