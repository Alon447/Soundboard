import * as Icons from 'lucide-react';
import { Button } from '@heroui/react';

/**
 * No form: Keycloak owns credentials. A button rather than an automatic redirect, because
 * `/api/me` failing because the backend is down would otherwise bounce in a loop.
 */
export default function SignInPrompt() {
	const signIn = () => {
		const url = new URL('/auth/login', window.location.origin);
		url.searchParams.set('state', window.location.href);
		window.location.assign(url);
	};

	return (
		<div className="min-h-screen bg-[#0a0a0b] text-white flex items-center justify-center p-6">
			<div className="w-full max-w-sm space-y-6 text-center">
				<div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/4">
					<Icons.AudioLines className="h-7 w-7 text-orange-400" />
				</div>

				<div className="space-y-1">
					<h1 className="text-2xl font-bold tracking-tight">Soundboard</h1>
					<p className="text-sm text-white/50">Sign in with your organisation account.</p>
				</div>

				<Button
					className="sb-button w-full"
					onPress={signIn}
				>
					Sign in
				</Button>
			</div>
		</div>
	);
}
