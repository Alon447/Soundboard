/**
 * Zustand store for Soundboard UI state + audio engine.
 *
 * Split into two logical slices kept in one store:
 *   UI slice  — volume, activeId, editMode, showAddModal, volumePopoverId
 *   Audio slice — AudioContext, GainNode, buffer cache, active sources, timers
 *                 (refs live here so they survive re-renders and aren't reactive)
 */

import { create } from 'zustand';
import { setSynthVolume } from '@/lib/synth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioRefs {
	ctx: AudioContext | null;
	masterGain: GainNode | null;
	/** URL → decoded AudioBuffer cache */
	buffers: Map<string, AudioBuffer>;
	/** sound.id → currently playing source */
	sources: Map<string, AudioBufferSourceNode>;
	/** sound.id → active timeout handle */
	timers: Record<string, number>;
}

export interface SoundStore {
	// ---- UI ------------------------------------------------------------------
	volume: number;
	activeId: string | null;
	editMode: boolean;
	showAddModal: boolean;
	/** dbId of the sound pad whose volume popover is open, or null */
	volumePopoverId: string | null;

	setVolume: (v: number) => void;
	setActiveId: (id: string | null) => void;
	setEditMode: (on: boolean) => void;
	toggleEditMode: () => void;
	setShowAddModal: (show: boolean) => void;
	setVolumePopoverId: (id: string | null) => void;
	toggleVolumePopover: (dbId: string) => void;

	// ---- Audio engine refs ---------------------------------------------------
	/** Mutable audio refs — NOT reactive, never cause re-renders */
	audio: AudioRefs;

	/** Lazily create (or return existing) AudioContext + master gain chain */
	getAudioContext: () => AudioContext;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSoundStore = create<SoundStore>((set, get) => ({
	// ---- UI defaults ---------------------------------------------------------
	volume: 1,
	activeId: null,
	editMode: false,
	showAddModal: false,
	volumePopoverId: null,

	setVolume: (v) => {
		set({ volume: v });
		// Keep Web Audio master gain in sync immediately
		const { audio } = get();
		if (audio.masterGain) audio.masterGain.gain.value = v;
		setSynthVolume(v);
	},

	setActiveId: (id) => set({ activeId: id }),

	setEditMode: (on) => set({ editMode: on, volumePopoverId: null }),

	toggleEditMode: () => {
		const { editMode } = get();
		set({ editMode: !editMode, volumePopoverId: null });
	},

	setShowAddModal: (show) => set({ showAddModal: show }),

	setVolumePopoverId: (id) => set({ volumePopoverId: id }),

	toggleVolumePopover: (dbId) => {
		const { volumePopoverId } = get();
		set({ volumePopoverId: volumePopoverId === dbId ? null : dbId });
	},

	// ---- Audio refs (mutable, not part of reactive state) --------------------
	audio: {
		ctx: null,
		masterGain: null,
		buffers: new Map(),
		sources: new Map(),
		timers: {},
	},

	getAudioContext: () => {
		const { audio, volume } = get();
		if (audio.ctx) return audio.ctx;

		const windowWithWebkit = window as Window & { webkitAudioContext?: typeof AudioContext };
		const Ctor = window.AudioContext ?? windowWithWebkit.webkitAudioContext!;
		const ctx = new Ctor();
		const masterGain = ctx.createGain();
		masterGain.gain.value = volume;
		masterGain.connect(ctx.destination);

		// Mutate the refs object directly — no set() so this doesn't re-render
		audio.ctx = ctx;
		audio.masterGain = masterGain;

		return ctx;
	},
}));
