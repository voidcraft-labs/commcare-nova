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
import { ImpersonationBanner } from "@/components/ui/ImpersonationBanner";
import { Logo } from "@/components/ui/Logo";

const FEEDBACK_FORM_URL =
	"https://docs.google.com/forms/d/e/1FAIpQLSdUHQuE9kYhG-py9pojdCDc5ChSrl2LnhLofY4kDlOQi6ghGw/viewform";

/* In prod the docs site is on its own subdomain, so the link is
 * cross-origin and gets the new-tab affordance. In dev it points at
 * the internal `/docs` route on `localhost:3000` and stays in-tab so
 * developers can bounce back from a preview without juggling windows.
 * `process.env.NODE_ENV` is inlined by Next at build time, so each
 * bundle ships only one branch. */
const DOCS_LINK_PROPS =
	process.env.NODE_ENV === "development"
		? { href: "/docs" }
		: {
				href: "https://docs.commcare.app/",
				target: "_blank",
				rel: "noopener noreferrer",
			};

interface ImpersonationState {
	userName: string;
	userEmail: string;
}

interface AppHeaderProps {
	/** Whether the current user has admin role — passed through to HeaderNav. */
	isAdmin: boolean;
	/** Whether the user is authenticated — controls header visibility. */
	isAuthenticated: boolean;
	/** Active impersonation info, or null when viewing as yourself. */
	impersonating: ImpersonationState | null;
}

export function AppHeader({
	isAdmin,
	isAuthenticated,
	impersonating,
}: AppHeaderProps) {
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

			{impersonating ? (
				<div className="flex-1 flex justify-center">
					<ImpersonationBanner
						userName={impersonating.userName}
						userEmail={impersonating.userEmail}
					/>
				</div>
			) : null}

			<div className="ml-auto flex items-center gap-2">
				<a
					{...DOCS_LINK_PROPS}
					className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-nova-text-muted transition-colors hover:text-nova-text hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-nova-violet focus-visible:outline-none"
				>
					Docs
					<Icon icon={externalLinkIcon} width="16" height="16" />
				</a>
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
