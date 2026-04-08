/**
 * Global app header — rendered once in the root layout, every page.
 *
 * Always visible when the user is authenticated. Hidden on the landing
 * page (unauthenticated `/`). Uses `isAuthenticated` from the server-resolved
 * session rather than pathname checks — the same `/` route renders both
 * the landing and the app list depending on auth state.
 */

"use client";

import { Icon } from "@iconify/react/offline";
import externalLinkIcon from "@iconify-icons/tabler/external-link";
import Link from "next/link";
import { AccountMenu } from "@/components/ui/AccountMenu";
import { HeaderNavLinks } from "@/components/ui/HeaderNav";
import { Logo } from "@/components/ui/Logo";

const FEEDBACK_FORM_URL =
	"https://docs.google.com/forms/d/e/1FAIpQLSdUHQuE9kYhG-py9pojdCDc5ChSrl2LnhLofY4kDlOQi6ghGw/viewform";

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
			<div className="ml-auto flex items-center gap-2">
				<a
					href={FEEDBACK_FORM_URL}
					target="_blank"
					rel="noopener noreferrer"
					className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-nova-text-muted transition-colors hover:text-nova-text hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-nova-violet focus-visible:outline-none"
				>
					Give Feedback
					<Icon icon={externalLinkIcon} width="16" height="16" />
				</a>
				<AccountMenu />
			</div>
		</header>
	);
}
