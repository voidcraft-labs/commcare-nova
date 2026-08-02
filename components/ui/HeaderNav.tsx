/**
 * Nav links rendered left-aligned next to the logo in AppHeader.
 *
 * Client component: needs `usePathname()` for active state. Accepts `isAdmin`
 * as a prop rather than reading from `useAuth()` to avoid a client session fetch
 * and the resulting flash where the Admin link pops in after hydration. Server
 * pages already resolve the session: they pass `isAdmin` directly.
 */

"use client";

import type { IconifyIcon } from "@iconify/react/offline";
import { Icon } from "@iconify/react/offline";
import tablerApps from "@iconify-icons/tabler/apps";
import tablerUserShield from "@iconify-icons/tabler/user-shield";
import Link from "next/link";
import { usePathname } from "next/navigation";

// ── Nav definition ────────────────────────────────────────────────────

interface NavItem {
	href: string;
	label: string;
	icon: IconifyIcon;
	/** Pathname prefix for active detection (e.g. '/admin' matches '/admin/*'). */
	matchPrefix?: string;
	/** Exact pathname match instead of prefix (e.g. '/' matches only '/'). */
	matchExact?: boolean;
	/** Only render when user has admin role. */
	adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
	{
		href: "/",
		label: "Apps",
		icon: tablerApps,
		matchExact: true,
	},
	{
		href: "/admin",
		label: "Admin",
		icon: tablerUserShield,
		matchPrefix: "/admin",
		adminOnly: true,
	},
];

// ── Styles ────────────────────────────────────────────────────────────

/** Active state uses `bg-white/[0.08]` for a visible indicator against the
 *  void header background (`bg-nova-surface` produced only 1.1:1). A nav link
 *  is a text-tier control, so it meets the 44px floor and presses with the
 *  1px nudge text-tier controls use, not a scale. */
function navLinkClass(active: boolean): string {
	const base =
		"nova-focusable flex min-h-11 min-w-11 items-center justify-center gap-1.5 px-3 text-sm rounded-xl transition-all active:translate-y-px cursor-pointer sm:justify-start";
	return active
		? `${base} text-nova-text bg-white/[0.08]`
		: `${base} text-nova-text-secondary hover:text-nova-text hover:bg-white/[0.06]`;
}

// ── Component ─────────────────────────────────────────────────────────

interface HeaderNavProps {
	/** Whether the current user has admin role: controls visibility of the Admin link. */
	isAdmin?: boolean;
}

/** Nav links only: rendered left-aligned next to the logo. */
export function HeaderNavLinks({ isAdmin }: HeaderNavProps) {
	const pathname = usePathname();

	return (
		<nav className="flex items-center gap-1" aria-label="Main navigation">
			{NAV_ITEMS.map((item) => {
				if (item.adminOnly && !isAdmin) return null;
				const isActive = item.matchExact
					? pathname === item.href
					: !!item.matchPrefix && pathname.startsWith(item.matchPrefix);
				return (
					<Link
						key={item.href}
						href={item.href}
						aria-label={item.label}
						className={navLinkClass(isActive)}
						{...(isActive ? { "aria-current": "page" as const } : {})}
					>
						<Icon icon={item.icon} width="16" height="16" />
						<span className="hidden sm:inline">{item.label}</span>
					</Link>
				);
			})}
		</nav>
	);
}
