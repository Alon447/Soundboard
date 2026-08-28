let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;

function getCtx(): AudioContext {
	if (!ctx) {
		ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
		masterGain = ctx.createGain();
		masterGain.gain.value = 1;
		masterGain.connect(ctx.destination);
	}
	if (ctx.state === 'suspended') ctx.resume();
	return ctx;
}

export function setSynthVolume(v: number) {
	if (masterGain) masterGain.gain.value = v;
}

function out(): GainNode {
	getCtx();
	return masterGain!;
}

function noiseBuffer(duration: number): AudioBuffer {
	const c = getCtx();
	const buf = c.createBuffer(1, Math.floor(c.sampleRate * duration), c.sampleRate);
	const data = buf.getChannelData(0);
	for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
	return buf;
}

function kick(t: number) {
	const c = getCtx();
	const osc = c.createOscillator();
	const g = c.createGain();
	osc.type = 'sine';
	osc.frequency.setValueAtTime(150, t);
	osc.frequency.exponentialRampToValueAtTime(0.001, t + 0.5);
	g.gain.setValueAtTime(1, t);
	g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
	osc.connect(g).connect(out());
	osc.start(t);
	osc.stop(t + 0.5);
}

function snare(t: number) {
	const c = getCtx();
	const noise = c.createBufferSource();
	noise.buffer = noiseBuffer(0.2);
	const nf = c.createBiquadFilter();
	nf.type = 'highpass';
	nf.frequency.value = 1000;
	const ng = c.createGain();
	ng.gain.setValueAtTime(0.7, t);
	ng.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
	noise.connect(nf).connect(ng).connect(out());
	noise.start(t);
	noise.stop(t + 0.2);

	const osc = c.createOscillator();
	const og = c.createGain();
	osc.type = 'triangle';
	osc.frequency.setValueAtTime(180, t);
	og.gain.setValueAtTime(0.5, t);
	og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
	osc.connect(og).connect(out());
	osc.start(t);
	osc.stop(t + 0.1);
}

function hihat(t: number) {
	const c = getCtx();
	const noise = c.createBufferSource();
	noise.buffer = noiseBuffer(0.05);
	const f = c.createBiquadFilter();
	f.type = 'highpass';
	f.frequency.value = 7000;
	const g = c.createGain();
	g.gain.setValueAtTime(0.4, t);
	g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
	noise.connect(f).connect(g).connect(out());
	noise.start(t);
	noise.stop(t + 0.05);
}

function clap(t: number) {
	const c = getCtx();
	for (const d of [0, 0.01, 0.02, 0.03]) {
		const noise = c.createBufferSource();
		noise.buffer = noiseBuffer(0.1);
		const f = c.createBiquadFilter();
		f.type = 'bandpass';
		f.frequency.value = 1200;
		f.Q.value = 1.5;
		const g = c.createGain();
		g.gain.setValueAtTime(0.5, t + d);
		g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.1);
		noise.connect(f).connect(g).connect(out());
		noise.start(t + d);
		noise.stop(t + d + 0.1);
	}
}

function bassDrop(t: number) {
	const c = getCtx();
	const osc = c.createOscillator();
	const g = c.createGain();
	osc.type = 'sawtooth';
	osc.frequency.setValueAtTime(80, t);
	osc.frequency.exponentialRampToValueAtTime(20, t + 1.5);
	g.gain.setValueAtTime(0.8, t);
	g.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
	const f = c.createBiquadFilter();
	f.type = 'lowpass';
	f.frequency.value = 200;
	osc.connect(f).connect(g).connect(out());
	osc.start(t);
	osc.stop(t + 1.5);
}

function airHorn(t: number) {
	const c = getCtx();
	for (const freq of [311, 415, 466]) {
		const osc = c.createOscillator();
		const g = c.createGain();
		osc.type = 'sawtooth';
		osc.frequency.setValueAtTime(freq, t);
		g.gain.setValueAtTime(0, t);
		g.gain.linearRampToValueAtTime(0.25, t + 0.05);
		g.gain.setValueAtTime(0.25, t + 1.2);
		g.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
		const f = c.createBiquadFilter();
		f.type = 'bandpass';
		f.frequency.value = freq * 2;
		f.Q.value = 2;
		osc.connect(f).connect(g).connect(out());
		osc.start(t);
		osc.stop(t + 1.5);
	}
}

function laser(t: number) {
	const c = getCtx();
	const osc = c.createOscillator();
	const g = c.createGain();
	osc.type = 'sawtooth';
	osc.frequency.setValueAtTime(2000, t);
	osc.frequency.exponentialRampToValueAtTime(100, t + 0.3);
	g.gain.setValueAtTime(0.5, t);
	g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
	osc.connect(g).connect(out());
	osc.start(t);
	osc.stop(t + 0.3);
}

function boing(t: number) {
	const c = getCtx();
	const osc = c.createOscillator();
	const g = c.createGain();
	osc.type = 'sine';
	osc.frequency.setValueAtTime(100, t);
	osc.frequency.exponentialRampToValueAtTime(500, t + 0.1);
	osc.frequency.exponentialRampToValueAtTime(100, t + 0.3);
	g.gain.setValueAtTime(0.5, t);
	g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
	osc.connect(g).connect(out());
	osc.start(t);
	osc.stop(t + 0.4);
}

function recordScratch(t: number) {
	const c = getCtx();
	const noise = c.createBufferSource();
	noise.buffer = noiseBuffer(0.3);
	const f = c.createBiquadFilter();
	f.type = 'bandpass';
	f.frequency.setValueAtTime(2000, t);
	f.frequency.linearRampToValueAtTime(500, t + 0.3);
	f.Q.value = 5;
	const g = c.createGain();
	g.gain.setValueAtTime(0.4, t);
	g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
	noise.connect(f).connect(g).connect(out());
	noise.start(t);
	noise.stop(t + 0.3);
}

function bell(t: number) {
	const c = getCtx();
	for (const [freq, i] of [
		[880, 0],
		[880 * 2.76, 1],
		[880 * 5.4, 2],
	] as [number, number][]) {
		const osc = c.createOscillator();
		const g = c.createGain();
		osc.type = 'sine';
		osc.frequency.value = freq;
		g.gain.setValueAtTime(0.4 / (i + 1), t);
		g.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
		osc.connect(g).connect(out());
		osc.start(t);
		osc.stop(t + 1.5);
	}
}

function rimshot(t: number) {
	const c = getCtx();
	const noise = c.createBufferSource();
	noise.buffer = noiseBuffer(0.05);
	const f = c.createBiquadFilter();
	f.type = 'bandpass';
	f.frequency.value = 2500;
	f.Q.value = 3;
	const g = c.createGain();
	g.gain.setValueAtTime(0.6, t);
	g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
	noise.connect(f).connect(g).connect(out());
	noise.start(t);
	noise.stop(t + 0.05);
}

function buzzer(t: number) {
	const c = getCtx();
	const osc = c.createOscillator();
	const g = c.createGain();
	osc.type = 'square';
	osc.frequency.value = 220;
	g.gain.setValueAtTime(0.3, t);
	g.gain.setValueAtTime(0.3, t + 0.8);
	g.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
	osc.connect(g).connect(out());
	osc.start(t);
	osc.stop(t + 1.0);
}

function coin(t: number) {
	const c = getCtx();
	for (const [freq, time] of [
		[988, 0],
		[1319, 0.06],
	] as [number, number][]) {
		const osc = c.createOscillator();
		const g = c.createGain();
		osc.type = 'square';
		osc.frequency.value = freq;
		g.gain.setValueAtTime(0.2, t + time);
		g.gain.exponentialRampToValueAtTime(0.001, t + time + 0.1);
		osc.connect(g).connect(out());
		osc.start(t + time);
		osc.stop(t + time + 0.1);
	}
}

function powerUp(t: number) {
	const c = getCtx();
	const notes = [523, 659, 784, 1047];
	notes.forEach((freq, i) => {
		const osc = c.createOscillator();
		const g = c.createGain();
		osc.type = 'square';
		osc.frequency.value = freq;
		const start = t + i * 0.06;
		g.gain.setValueAtTime(0.2, start);
		g.gain.exponentialRampToValueAtTime(0.001, start + 0.08);
		osc.connect(g).connect(out());
		osc.start(start);
		osc.stop(start + 0.08);
	});
}

function alarm(t: number) {
	const c = getCtx();
	for (let i = 0; i < 3; i++) {
		const start = t + i * 0.3;
		const osc = c.createOscillator();
		const g = c.createGain();
		osc.type = 'sawtooth';
		osc.frequency.setValueAtTime(800, start);
		osc.frequency.setValueAtTime(800, start + 0.12);
		osc.frequency.linearRampToValueAtTime(400, start + 0.15);
		g.gain.setValueAtTime(0.25, start);
		g.gain.setValueAtTime(0.25, start + 0.12);
		g.gain.exponentialRampToValueAtTime(0.001, start + 0.15);
		osc.connect(g).connect(out());
		osc.start(start);
		osc.stop(start + 0.15);
	}
}

function whoosh(t: number) {
	const c = getCtx();
	const noise = c.createBufferSource();
	noise.buffer = noiseBuffer(0.4);
	const f = c.createBiquadFilter();
	f.type = 'bandpass';
	f.frequency.setValueAtTime(200, t);
	f.frequency.exponentialRampToValueAtTime(3000, t + 0.2);
	f.frequency.exponentialRampToValueAtTime(200, t + 0.4);
	f.Q.value = 1;
	const g = c.createGain();
	g.gain.setValueAtTime(0, t);
	g.gain.linearRampToValueAtTime(0.4, t + 0.1);
	g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
	noise.connect(f).connect(g).connect(out());
	noise.start(t);
	noise.stop(t + 0.4);
}

function drumroll(t: number) {
	const c = getCtx();
	for (let i = 0; i < 8; i++) {
		const start = t + i * 0.06;
		const noise = c.createBufferSource();
		noise.buffer = noiseBuffer(0.05);
		const f = c.createBiquadFilter();
		f.type = 'highpass';
		f.frequency.value = 5000;
		const g = c.createGain();
		g.gain.setValueAtTime(0.3, start);
		g.gain.exponentialRampToValueAtTime(0.001, start + 0.05);
		noise.connect(f).connect(g).connect(out());
		noise.start(start);
		noise.stop(start + 0.05);
	}
}

function blip(t: number) {
	const c = getCtx();
	const osc = c.createOscillator();
	const g = c.createGain();
	osc.type = 'square';
	osc.frequency.setValueAtTime(440, t);
	osc.frequency.setValueAtTime(660, t + 0.05);
	g.gain.setValueAtTime(0.2, t);
	g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
	osc.connect(g).connect(out());
	osc.start(t);
	osc.stop(t + 0.1);
}

function explosion(t: number) {
	const c = getCtx();
	const noise = c.createBufferSource();
	noise.buffer = noiseBuffer(1.0);
	const f = c.createBiquadFilter();
	f.type = 'lowpass';
	f.frequency.setValueAtTime(1000, t);
	f.frequency.exponentialRampToValueAtTime(50, t + 1.0);
	const g = c.createGain();
	g.gain.setValueAtTime(0.8, t);
	g.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
	noise.connect(f).connect(g).connect(out());
	noise.start(t);
	noise.stop(t + 1.0);
}

function ding(t: number) {
	const c = getCtx();
	const osc = c.createOscillator();
	const g = c.createGain();
	osc.type = 'sine';
	osc.frequency.value = 1318;
	g.gain.setValueAtTime(0.4, t);
	g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
	osc.connect(g).connect(out());
	osc.start(t);
	osc.stop(t + 0.5);
}

function tom(t: number) {
	const c = getCtx();
	const osc = c.createOscillator();
	const g = c.createGain();
	osc.type = 'sine';
	osc.frequency.setValueAtTime(250, t);
	osc.frequency.exponentialRampToValueAtTime(80, t + 0.3);
	g.gain.setValueAtTime(0.7, t);
	g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
	osc.connect(g).connect(out());
	osc.start(t);
	osc.stop(t + 0.3);
}

function wobble(t: number) {
	const c = getCtx();
	const osc = c.createOscillator();
	const lfo = c.createOscillator();
	const lfoGain = c.createGain();
	const g = c.createGain();
	osc.type = 'sawtooth';
	osc.frequency.value = 200;
	lfo.frequency.value = 8;
	lfoGain.gain.value = 80;
	lfo.connect(lfoGain).connect(osc.frequency);
	g.gain.setValueAtTime(0.3, t);
	g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
	osc.connect(g).connect(out());
	osc.start(t);
	lfo.start(t);
	osc.stop(t + 0.6);
	lfo.stop(t + 0.6);
}

const GENERATORS: Record<string, (t: number) => void> = {
	kick,
	snare,
	hihat,
	clap,
	bassDrop,
	airHorn,
	laser,
	boing,
	recordScratch,
	bell,
	rimshot,
	buzzer,
	coin,
	powerUp,
	alarm,
	whoosh,
	drumroll,
	blip,
	explosion,
	ding,
	tom,
	wobble,
};

export function playSynth(id: string) {
	const gen = GENERATORS[id];
	if (!gen) return;
	const c = getCtx();
	gen(c.currentTime);
}
