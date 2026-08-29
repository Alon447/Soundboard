import { useCallback, useEffect } from 'react';
import * as Icons from 'lucide-react';
import { Button, Tooltip, TooltipContent, TooltipTrigger, Spinner } from '@heroui/react';
import { useAuth } from '@/lib/useAuth';
import { useUserSounds, type BoardSound } from '@/lib/useUserSounds';
import { useSoundStore } from '@/store/soundStore';
import { playSynth } from '@/lib/synth';
import AuthPage from '@/components/AuthPage';
import AddSoundModal from '@/components/AddSoundModal';
import SoundPad from '@/components/soundboard/SoundPad';
import { assetPath, isSynth } from '@/components/soundboard/soundboardUtils';

const PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
	const { user, loading: authLoading, signOut } = useAuth();
	const {
		sounds,
		loading: soundsLoading,
		error,
		addBuiltinSound,
		addCustomSound,
		removeSound,
		moveSound,
		updateGain,
	} = useUserSounds();

	// Zustand store — pull only what each section needs (fine-grained subscriptions)
	const activeId = useSoundStore((s) => s.activeId);
	const setActiveId = useSoundStore((s) => s.setActiveId);
	const editMode = useSoundStore((s) => s.editMode);
	const toggleEditMode = useSoundStore((s) => s.toggleEditMode);
	const showAddModal = useSoundStore((s) => s.showAddModal);
	const setShowAddModal = useSoundStore((s) => s.setShowAddModal);
	const volumePopoverId = useSoundStore((s) => s.volumePopoverId);
	const toggleVolumePopover = useSoundStore((s) => s.toggleVolumePopover);
	const setVolumePopoverId = useSoundStore((s) => s.setVolumePopoverId);
	const getAudioContext = useSoundStore((s) => s.getAudioContext);
	const audio = useSoundStore((s) => s.audio);

	// ---- Audio engine --------------------------------------------------------

	const getBuffer = useCallback(
		async (url: string, ctx: AudioContext): Promise<AudioBuffer> => {
			const cached = audio.buffers.get(url);
			if (cached) return cached;
			const res = await fetch(url);
			if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
			const buf = await ctx.decodeAudioData(await res.arrayBuffer());
			audio.buffers.set(url, buf);
			return buf;
		},
		[audio],
	);

	const triggerPad = useCallback(
		async (sound: BoardSound) => {
			// Visual flash — immediate
			setActiveId(sound.id);
			if (audio.timers[sound.id]) clearTimeout(audio.timers[sound.id]);
			audio.timers[sound.id] = window.setTimeout(() => setActiveId(null), 300);

			if (isSynth(sound.audio_path)) {
				playSynth(sound.audio_path.slice(6));
				return;
			}

			try {
				const ctx = getAudioContext();
				if (ctx.state === 'suspended') await ctx.resume();

				const prev = audio.sources.get(sound.id);
				if (prev) {
					try {
						prev.stop();
					} catch {
						/* already ended */
					}
					audio.sources.delete(sound.id);
				}

				const buffer = await getBuffer(assetPath(sound.audio_path), ctx);

				const soundGain = ctx.createGain();
				soundGain.gain.value = sound.gain ?? 1;
				soundGain.connect(audio.masterGain!);

				const source = ctx.createBufferSource();
				source.buffer = buffer;
				source.connect(soundGain);
				source.start(0);
				audio.sources.set(sound.id, source);
				source.onended = () => audio.sources.delete(sound.id);
			} catch (err) {
				console.error('Playback failed:', err);
			}
		},
		[audio, getAudioContext, getBuffer, setActiveId],
	);

	// Keyboard shortcuts
	useEffect(() => {
		if (editMode) return;
		const handler = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
			const i = PAD_KEYS.indexOf(e.key);
			if (i >= 0 && i < sounds.length) {
				e.preventDefault();
				triggerPad(sounds[i]);
			}
		};
		window.addEventListener('keydown', handler);
		return () => window.removeEventListener('keydown', handler);
	}, [triggerPad, sounds, editMode]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			Object.values(audio.timers).forEach(clearTimeout);
			audio.ctx?.close().catch(() => undefined);
		};
	}, [audio]);

	// ---- Auth guard ----------------------------------------------------------
	if (authLoading) {
		return (
			<div className="min-h-screen bg-[#0a0a0b] flex items-center justify-center">
				<Spinner size="lg" />
			</div>
		);
	}
	if (!user) return <AuthPage />;

	const existingSoundIds = sounds.map((s) => s.id);
	const identityLabel = user.email ?? 'Signed in';

	return (
		<div className="min-h-screen bg-[#0a0a0b] text-white flex flex-col">
			{/* ── Header ─────────────────────────────────────────────────────────── */}
			<header className="border-b border-white/10 px-6 py-4 flex items-center justify-between flex-wrap gap-3">
				<div className="flex items-center gap-3">
					<div className="w-10 h-10 rounded-xl bg-linear-to-br from-orange-500 to-pink-500 flex items-center justify-center">
						<Icons.Volume2 className="w-5 h-5" />
					</div>
					<div>
						<h1 className="text-lg font-bold tracking-tight">Soundboard</h1>
						<p className="text-xs text-white/40">{identityLabel}</p>
					</div>
				</div>

				<div className="flex items-center gap-3 flex-wrap">
					{/* Edit mode */}
					<Button
						variant={editMode ? 'primary' : 'secondary'}
						size="sm"
						className="sb-button"
						onPress={toggleEditMode}
					>
						<Icons.Pencil className="w-3.5 h-3.5" />
						{editMode ? 'Done' : 'Edit'}
					</Button>

					<Button
						variant="primary"
						size="sm"
						className="sb-button"
						onPress={() => setShowAddModal(true)}
					>
						<Icons.Plus className="w-3.5 h-3.5" />
						Add Sound
					</Button>

					{/* Sign out */}
					<Tooltip>
						<TooltipTrigger>
							<Button
								isIconOnly
								variant="ghost"
								size="sm"
								className="sb-button"
								onPress={signOut}
								aria-label="Sign out"
							>
								<Icons.LogOut className="w-4 h-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>Sign out</TooltipContent>
					</Tooltip>
				</div>
			</header>

			{/* ── Main ───────────────────────────────────────────────────────────── */}
			<main className="flex-1 flex items-center justify-center p-6">
				{soundsLoading ? (
					<Spinner size="lg" />
				) : error ? (
					<p className="text-sm text-red-400">Failed to load sounds: {error}</p>
				) : sounds.length === 0 ? (
					<div className="max-w-sm w-full text-center space-y-4">
						<div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-white/4">
							<Icons.Music className="w-8 h-8 text-white/20" />
						</div>
						<div>
							<p className="text-white/60 font-medium">No sounds yet</p>
							<p className="text-sm text-white/30 mt-1">Add sounds from the library or upload your own</p>
						</div>
						<Button
							variant="primary"
							className="sb-button"
							onPress={() => setShowAddModal(true)}
						>
							<Icons.Plus className="w-4 h-4" />
							Add your first sound
						</Button>
					</div>
				) : (
					<div className="w-full max-w-4xl space-y-3">
						<div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3 max-w-4xl w-full">
							{sounds.map((sound, index) => {
								const isActive = activeId === sound.id;
								const keyHint = PAD_KEYS[index];
								const isVolumeOpen = volumePopoverId === sound.dbId;

								return (
									<SoundPad
										key={sound.dbId}
										sound={sound}
										index={index}
										totalSounds={sounds.length}
										editMode={editMode}
										isActive={isActive}
										keyHint={keyHint}
										isVolumeOpen={isVolumeOpen}
										onTrigger={(nextSound) => {
											void triggerPad(nextSound);
										}}
										onRemove={(dbId) => {
											void removeSound(dbId);
										}}
										onMove={(dbId, direction) => {
											void moveSound(dbId, direction);
										}}
										onUpdateGain={(dbId, gain) => {
											void updateGain(dbId, gain);
										}}
										onToggleVolumePopover={toggleVolumePopover}
										onCloseVolumePopover={() => setVolumePopoverId(null)}
									/>
								);
							})}

							<button
								onClick={() => setShowAddModal(true)}
								className="aspect-square rounded-2xl border border-dashed border-white/15 flex flex-col items-center justify-center gap-1.5 text-white/30 hover:text-white/60 hover:border-white/30 transition"
							>
								<Icons.Plus className="w-6 h-6" />
								<span className="text-[11px] font-medium">Add</span>
							</button>
						</div>
					</div>
				)}
			</main>

			{/* ── Footer ─────────────────────────────────────────────────────────── */}
			<footer className="border-t border-white/10 px-6 py-3 flex items-center justify-center text-xs text-white/40">
				{activeId ? (
					<span className="flex items-center gap-2">
						<span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
						Playing: {sounds.find((s) => s.id === activeId)?.name}
					</span>
				) : (
					<span>
						{sounds.length} sound{sounds.length !== 1 ? 's' : ''}
						{sounds.length > 0 && !editMode ? ' — keys 1-9, 0, -, = trigger pads' : ''}
						{editMode ? ' — edit mode' : ''}
					</span>
				)}
			</footer>

			{/* ── Add Sound Modal ─────────────────────────────────────────────────── */}
			{showAddModal && (
				<AddSoundModal
					existingSoundIds={existingSoundIds}
					onAddBuiltin={addBuiltinSound}
					onAddCustom={addCustomSound}
					onClose={() => setShowAddModal(false)}
				/>
			)}
		</div>
	);
}
