/**
 * Global app header — rendered once in the root layout, every page.
 *
 * Always visible on all routes except the landing page (`/`).
 * Mounts a single `HeaderNav` (and therefore a single `AccountMenu`)
 * that persists across navigations — no conditional mount/unmount.
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HeaderNav } from "@/components/ui/HeaderNav";
import { Logo } from "@/components/ui/Logo";

interface AppHeaderProps {
	/** Whether the current user has admin role — passed through to HeaderNav. */
	isAdmin: boolean;
}

export function AppHeader({ isAdmin }: AppHeaderProps) {
	const pathname = usePathname();

	/* Landing page — no header at all. */
	if (pathname === "/") return null;

	return (
		<header className="border-b border-nova-border px-4 py-2.5 flex items-center justify-between bg-nova-void shrink-0">
			<Link
				href="/builds"
				className="rounded-lg focus-visible:ring-2 focus-visible:ring-nova-violet focus-visible:outline-none"
			>
				<Logo size="sm" />
			</Link>
			<HeaderNav isAdmin={isAdmin} />
		</header>
	);
}
