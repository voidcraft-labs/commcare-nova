import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import Link from "next/link";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/Skeleton";
import { getSession } from "@/lib/auth-utils";
import { AppList } from "./app-list";
import { Landing } from "./landing";

/**
 * Root page — app list for authenticated users, sign-in for everyone else.
 *
 * Server component that resolves the session once. Authenticated users see
 * their apps immediately (the list streams via Suspense). Unauthenticated
 * users see the landing page with Google OAuth sign-in.
 */
export default async function HomePage() {
	const session = await getSession();

	if (!session) return <Landing />;

	const isAdmin = session.session?.isAdmin === true;

	return (
		<main className="max-w-4xl mx-auto px-6 py-12">
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

			<Suspense fallback={<AppListFallback />}>
				<AppList email={session.user.email} isAdmin={isAdmin} />
			</Suspense>
		</main>
	);
}

// ── Suspense fallback — matches AppCard grid layout ─────────────────

const SKELETON_KEYS = ["a", "b", "c", "d"] as const;

function AppListFallback() {
	return (
		<div className="grid gap-3">
			{SKELETON_KEYS.map((key) => (
				<div
					key={key}
					className="p-4 bg-nova-surface border border-nova-border rounded-lg flex items-center justify-between"
				>
					<div>
						<Skeleton className="w-36 h-5" />
						<div className="flex items-center gap-3 mt-2">
							<Skeleton className="w-20 h-3.5" />
							<Skeleton className="w-28 h-3.5" />
						</div>
					</div>
					<Skeleton className="w-16 h-6 rounded-md" />
				</div>
			))}
		</div>
	);
}
