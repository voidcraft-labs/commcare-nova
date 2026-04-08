/**
 * Async server component for the app list.
 *
 * Separated from the builds page so it can be wrapped in a Suspense boundary.
 * The data fetch (Firestore query) happens here — the page shell streams
 * immediately while this component resolves.
 *
 * If the user has no apps, redirects straight to `/build/new` — no empty
 * state to maintain, and matches the post-sign-in flow (which also lands
 * on `/build/new` via callbackURL).
 */

import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppCardList } from "@/components/ui/AppCardList";
import { listApps } from "@/lib/db/apps";

interface AppListProps {
	/** Owner ID (Better Auth user ID) — used to query apps by owner. */
	userId: string;
	/** Whether to show replay buttons (admin-only feature). */
	isAdmin: boolean;
}

export async function AppList({ userId, isAdmin }: AppListProps) {
	const apps = await listApps(userId);

	if (apps.length === 0) redirect("/build/new");

	return (
		<>
			<div className="flex items-center justify-between mb-8">
				<h1 className="text-2xl font-display font-semibold">Your Apps</h1>
				<Link
					href="/build/new"
					className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-nova-violet text-white border border-transparent hover:bg-nova-violet-bright shadow-[var(--nova-glow-violet)] transition-all duration-200"
				>
					<Icon icon={tablerPlus} width="14" height="14" />
					New App
				</Link>
			</div>

			<AppCardList apps={apps} linkToApps showReplay={isAdmin} />
		</>
	);
}
