import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export type AuthUser = {
	id: string;
	email: string | null;
	user_metadata: { name: string | null };
};

type AuthContextValue = {
	user: AuthUser | null;
	loading: boolean;
};

const AuthContext = createContext<AuthContextValue>({
	user: null,
	loading: true,
});

export function AuthProvider({ children }: { children: ReactNode }) {
	const { data: user = null, isLoading: loading } = useQuery({
		queryKey: ['me'],
		queryFn: () => api.get<AuthUser>('/me'),
		// A 401 means "no session", which is an answer, not a failure to retry.
		retry: false,
		staleTime: Infinity,
	});

	return <AuthContext.Provider value={{ user, loading }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
	return useContext(AuthContext);
}
