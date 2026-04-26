import { Icon } from "@iconify/react/offline";
import tablerSparkles from "@iconify-icons/tabler/sparkles";
import Link from "next/link";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/Skeleton";
import { getSession } from "@/lib/auth-utils";
import { userHasApps } from "@/lib/db/apps";
import { AppList } from "./app-list";
import { Landing } from "./landing";

/**
 * Root page — three branches, zero redirects:
 *
 * 1. Unauthenticated → Landing page with Google OAuth sign-in.
 * 2. Authenticated, no apps → Get-started prompt (rendered immediately,
 *    no Suspense skeleton) linking to `/build/new`.
 * 3. Authenticated, has apps → App list skeleton streams via Suspense
 *    while the full list loads from Firestore.
 *
 * The `userHasApps` existence check (`limit(1)`) runs before the Suspense
 * boundary so new users never see the app-list skeleton.
 */
export default async function HomePage() {
	const session = await getSession();

	if (!session) return <Landing />;

	const hasApps = await userHasApps(session.user.id);

	if (!hasApps) {
		return (
			<main className="min-h-full flex items-center justify-center px-6">
				<GetStarted />
			</main>
		);
	}

	const isAdmin = session.user.role === "admin";

	return (
		<main className="max-w-4xl mx-auto px-6 py-12">
			<Suspense fallback={<AppListFallback />}>
				<AppList userId={session.user.id} isAdmin={isAdmin} />
			</Suspense>
		</main>
	);
}

// ── First-time experience ─────────────────────────────────────────────

/** Shown when an authenticated user has no apps yet. */
function GetStarted() {
	return (
		<div className="flex flex-col items-center text-center">
			<h1 className="text-3xl font-display font-semibold mb-3">
				Build your first app
			</h1>
			<p className="text-nova-text-muted mb-8 max-w-md">
				Describe what you need and Nova will generate a CommCare app for you.
			</p>
			<Link
				href="/build/new"
				className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg bg-nova-violet text-white hover:bg-nova-violet-bright shadow-[var(--nova-glow-violet)] transition-all duration-200"
			>
				<Icon icon={tablerSparkles} width="16" height="16" />
				Get Started
			</Link>
		</div>
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
