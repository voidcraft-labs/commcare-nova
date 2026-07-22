import { Icon } from "@iconify/react/offline";
import tablerMail from "@iconify-icons/tabler/mail";
import tablerSparkles from "@iconify-icons/tabler/sparkles";
import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@/components/shadcn/button";
import { Skeleton } from "@/components/shadcn/skeleton";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import { getSession, resolveActiveProjectId } from "@/lib/auth-utils";
import { resolveProjectAccess } from "@/lib/db/appAccess";
import { projectHasApps } from "@/lib/db/apps";
import { listIncomingInvitations } from "@/lib/projects/membership";
import { AppList } from "./app-list";
import { Landing } from "./landing";

interface HomePageProps {
	/** Next.js 16 search params arrive async. The only key consulted here is
	 * `error`, populated by Better Auth's `errorCallbackURL` when sign-in is
	 * rejected (most often by the email-domain hook in `lib/auth.ts`). */
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Root page — three branches, zero redirects:
 *
 * 1. Unauthenticated → Landing page with Google OAuth sign-in. If the URL
 *    carries `?error=…` (set by Better Auth when an OAuth attempt is
 *    rejected), the message is forwarded to the landing page so it can
 *    render an inline banner.
 * 2. Authenticated, no apps → role-aware empty state (rendered immediately,
 *    no Suspense skeleton). Editors may start `/build/new`; viewers see who can.
 * 3. Authenticated, has apps → App list skeleton streams via Suspense
 *    while the active + recently-deleted lists load from Postgres.
 *    The active/deleted toggle lives in the client island below the
 *    fetch — it's a UI filter, not a routable state, so it stays out
 *    of the URL.
 *
 * The `projectHasApps` existence check (`limit(1)`) runs before the
 * Suspense boundary so a Project with no apps never shows the skeleton.
 */
export default async function HomePage({ searchParams }: HomePageProps) {
	const session = await getSession();

	if (!session) {
		const params = await searchParams;
		const errorParam = typeof params.error === "string" ? params.error : null;
		return <Landing signInError={errorParam} />;
	}

	const [activeProjectId, incoming] = await Promise.all([
		resolveActiveProjectId(session),
		listIncomingInvitations(session.user.email, new Date()),
	]);
	const [hasApps, activeAccess] = await Promise.all([
		projectHasApps(activeProjectId),
		resolveProjectAccess(session.user.id, activeProjectId, "view"),
	]);
	const canCreateApp = roleAllowsApp(activeAccess.role, "edit");
	const inviteCount = incoming.length;

	if (!hasApps) {
		return (
			<main className="min-h-full flex flex-col items-center justify-center px-6">
				{inviteCount > 0 && (
					<div className="w-full max-w-md mb-8">
						<InvitationsBanner count={inviteCount} />
					</div>
				)}
				<GetStarted canCreateApp={canCreateApp} />
			</main>
		);
	}

	return (
		<main className="max-w-4xl mx-auto px-6 py-12">
			{inviteCount > 0 && (
				<div className="mb-8">
					<InvitationsBanner count={inviteCount} />
				</div>
			)}
			<Suspense fallback={<AppListFallback />}>
				<AppList projectId={activeProjectId} userId={session.user.id} />
			</Suspense>
		</main>
	);
}

// ── Pending-invitation discovery ──────────────────────────────────────

/** Banner shown when the user has Project invitations awaiting a response —
 *  the in-app discovery point (no invitation email is sent). */
function InvitationsBanner({ count }: { count: number }) {
	return (
		<Link
			href="/accept-invitation"
			className="flex items-center gap-3 rounded-lg border border-nova-border bg-nova-surface px-4 py-3 text-sm transition-colors hover:bg-white/5"
		>
			<Icon
				icon={tablerMail}
				width="18"
				height="18"
				className="shrink-0 text-nova-violet-bright"
			/>
			<span className="flex-1 text-nova-text">
				You have {count} pending Project{" "}
				{count === 1 ? "invitation" : "invitations"}.
			</span>
			<span className="font-medium text-nova-violet-bright">Review</span>
		</Link>
	);
}

// ── First-time experience ─────────────────────────────────────────────

/** Shown when an authenticated user has no apps yet. */
function GetStarted({ canCreateApp }: { canCreateApp: boolean }) {
	return (
		<div className="flex flex-col items-center text-center">
			<h1 className="text-3xl font-display font-semibold mb-3">
				{canCreateApp ? "Build your first app" : "No apps yet"}
			</h1>
			<p className="text-nova-text-muted mb-8 max-w-md">
				{canCreateApp
					? "Describe what you need and Nova will generate a CommCare app for you."
					: "Someone with edit access can create the first app in this Project."}
			</p>
			{canCreateApp ? (
				<Button
					render={<Link href="/build/new" />}
					nativeButton={false}
					size="xl"
					className="shadow-[var(--nova-glow-violet)]"
				>
					<Icon icon={tablerSparkles} width="16" height="16" />
					Get Started
				</Button>
			) : null}
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
