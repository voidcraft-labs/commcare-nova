/**
 * Global app header — rendered once in the root layout, every page.
 *
 * Always visible when the user is authenticated. Hidden on the landing
 * page (unauthenticated `/`). Uses `isAuthenticated` from the server-resolved
 * session rather than pathname checks — the same `/` route renders both
 * the landing and the app list depending on auth state.
 */

"use client";

import Link from "next/link";
import { AccountMenu } from "@/components/ui/AccountMenu";
import { HeaderNavLinks } from "@/components/ui/HeaderNav";
import { Logo } from "@/components/ui/Logo";

interface AppHeaderProps {
	/** Whether the current user has admin role — passed through to HeaderNav. */
	isAdmin: boolean;
	/** Whether the user is authenticated — controls header visibility. */
	isAuthenticated: boolean;
}

export function AppHeader({ isAdmin, isAuthenticated }: AppHeaderProps) {
	/* Landing page (unauthenticated) — no header. */
	if (!isAuthenticated) return null;

	return (
		<header className="border-b border-nova-border px-4 py-2.5 flex items-center bg-nova-void shrink-0">
			<Link
				href="/"
				className="rounded-lg focus-visible:ring-2 focus-visible:ring-nova-violet focus-visible:outline-none"
			>
				<Logo size="sm" />
			</Link>
			<div className="ml-4">
				<HeaderNavLinks isAdmin={isAdmin} />
			</div>
			<div className="ml-auto">
				<AccountMenu />
			</div>
		</header>
	);
}
