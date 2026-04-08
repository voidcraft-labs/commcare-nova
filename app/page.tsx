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
		<>
			{/* Header skeleton — matches the header rendered by AppList */}
			<div className="flex items-center justify-between mb-8">
				<Skeleton className="w-32 h-7" />
				<Skeleton className="w-24 h-8 rounded-lg" />
			</div>

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
		</>
	);
}
