import { useState } from 'react';
import * as Icons from 'lucide-react';
import { Button, Input } from '@heroui/react';
import { supabase } from '@/lib/supabase';

type Mode = 'signin' | 'signup';

export default function AuthPage() {
	const [mode, setMode] = useState<Mode>('signin');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		setError(null);
		setMessage(null);
		setLoading(true);

		if (mode === 'signin') {
			const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
			if (signInError) setError(signInError.message);
		} else {
			const { data, error: signUpError } = await supabase.auth.signUp({ email, password });
			if (signUpError) {
				setError(signUpError.message);
			} else if (!data.session) {
				// No session means email confirmations are still enabled on the project.
				setMessage('Account created. Confirm your email, then sign in.');
			}
		}

		setLoading(false);
	};

	const switchMode = (next: Mode) => {
		setMode(next);
		setError(null);
		setMessage(null);
	};

	return (
		<div className="min-h-screen bg-[#0a0a0b] text-white flex items-center justify-center p-4">
			<div className="w-full max-w-sm">
				<div className="flex flex-col items-center gap-3 mb-8">
					<div className="w-14 h-14 rounded-2xl bg-linear-to-br from-orange-500 to-pink-500 flex items-center justify-center">
						<Icons.Volume2 className="w-7 h-7" />
					</div>
					<h1 className="text-2xl font-bold tracking-tight">Soundboard</h1>
					<p className="text-sm text-white/50">Sign in to load your board from Supabase</p>
				</div>

				<div className="rounded-2xl border border-white/10 bg-white/3 p-6 space-y-5">
					<div className="grid grid-cols-2 gap-1 rounded-xl border border-white/10 bg-white/3 p-1">
						{(['signin', 'signup'] as const).map((value) => (
							<button
								key={value}
								type="button"
								onClick={() => switchMode(value)}
								className={[
									'rounded-lg py-1.5 text-xs font-semibold transition',
									mode === value ? 'bg-white/10 text-white' : 'text-white/45 hover:text-white/70',
								].join(' ')}
							>
								{value === 'signin' ? 'Sign in' : 'Create account'}
							</button>
						))}
					</div>

					<form
						onSubmit={handleSubmit}
						className="space-y-3"
					>
						<label className="block space-y-1.5">
							<span className="text-xs text-white/50">Email</span>
							<Input
								type="email"
								required
								value={email}
								onChange={(event) => setEmail(event.target.value)}
								placeholder="you@example.com"
								autoComplete="email"
								variant="secondary"
								className="sb-input"
							/>
						</label>

						<label className="block space-y-1.5">
							<span className="text-xs text-white/50">Password</span>
							<Input
								type="password"
								required
								minLength={6}
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								placeholder="At least 6 characters"
								autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
								variant="secondary"
								className="sb-input"
							/>
						</label>

						{error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}
						{message && <p className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">{message}</p>}

						<Button
							type="submit"
							variant="primary"
							className="sb-button w-full"
							isDisabled={loading}
						>
							{loading ? <Icons.Loader2 className="w-4 h-4 animate-spin" /> : null}
							{mode === 'signin' ? 'Sign in' : 'Create account'}
						</Button>
					</form>
				</div>
			</div>
		</div>
	);
}
