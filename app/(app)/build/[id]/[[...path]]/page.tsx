/**
 * Build page — Server Component that fetches app data and composes the
 * client-side builder tree.
 *
 * This page uses an optional catch-all route (`[[...path]]`) so Next.js
 * serves the same RSC page for all intra-builder paths:
 *   /build/{id}              → home
 *   /build/{id}/{uuid}       → module or form
 *   /build/{id}/{uuid}/{uuid} → form + selected field
 *   /build/{id}/{uuid}/search  → case-search authoring
 *   /build/{id}/{uuid}/results → case-results authoring
 *   /build/{id}/{uuid}/details → case-details authoring
 *   /build/{id}/{uuid}/cases/{caseId} → case record
 *
 * The `path` param is NOT read here — all path resolution happens
 * client-side in `useLocation()` (via `useBuilderPathSegments` +
 * `parsePathToLocation`). Navigation uses the browser History API
 * (pushState/replaceState) so intra-builder screen changes are purely
 * client-side with zero server round-trips.
 *
 * Stale deep links (bookmarks with deleted UUIDs) are handled client-side
 * by `LocationRecoveryEffect`, which detects URL/location mismatches
 * and issues `replaceState` to fix the path.
 *
 * Conversation state loads here too: the thread list plus the most
 * recently active thread's full transcript, so a refresh always lands
 * back in the conversation the user was in — including a thread whose
 * run is still streaming (the client reconnects to it by thread id).
 */
import { notFound, redirect } from "next/navigation";
import { BuilderLayout } from "@/components/builder/BuilderLayout";
import { BuilderProvider } from "@/components/builder/BuilderProvider";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import { getSession, resolveActiveProjectId } from "@/lib/auth-utils";
import {
	AppAccessError,
	resolveAuthorizedAppSnapshot,
	resolveProjectAccess,
} from "@/lib/db/appAccess";
import { getCommCareSettings } from "@/lib/db/settings";
import {
	type LoadedThread,
	type LoadedThreadMeta,
	listThreadMetas,
	loadThread,
} from "@/lib/db/threads";
import type { AppDoc } from "@/lib/db/types";
import { log } from "@/lib/logger";

export default async function BuilderPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;

	const session = await getSession();
	if (!session) redirect("/");
	const commcareSettings = await getCommCareSettings(session.user.id);

	/* During impersonation, session.user is the target — surface their
	 * identity so BuilderHeader shows the banner, mirroring the site
	 * header in `(site)/layout.tsx`. */
	const impersonating = session.session.impersonatedBy
		? { userName: session.user.name, userEmail: session.user.email }
		: null;

	/* New apps have no blueprint/cursor yet, but they DO have a Project
	 * authority: creation targets the active Project. Resolve that role on the
	 * server and seed `{ baseSeq: 0 }` so a viewer's first client frame is
	 * truthfully read-only instead of defaulting to editor until the write route
	 * refuses them. The reconciler remains dormant until `data-app-id`. */
	if (id === "new") {
		const projectId = await resolveActiveProjectId(session);
		const access = await resolveProjectAccess(
			session.user.id,
			projectId,
			"view",
		);
		return (
			<BuilderProvider
				buildId={id}
				userId={session.user.id}
				initialAccess={{
					projectId,
					role: access.role,
					canEdit: roleAllowsApp(access.role, "edit"),
					baseSeq: 0,
				}}
			>
				<BuilderLayout
					commcareSettings={commcareSettings}
					impersonating={impersonating}
				/>
			</BuilderProvider>
		);
	}

	/* Project-membership gate (view) — any member may open the builder; edit
	 * is enforced at the write paths (PUT / chat / MCP). Denials collapse to
	 * notFound() to avoid leaking another Project's app. */
	let app: AppDoc;
	let initialAccess: {
		projectId: string;
		role: string;
		canEdit: boolean;
		baseSeq: number;
	};
	try {
		const snapshot = await resolveAuthorizedAppSnapshot(
			id,
			session.user.id,
			"view",
		);
		app = snapshot.app;
		initialAccess = {
			projectId: snapshot.projectId,
			role: snapshot.role,
			canEdit: snapshot.canEdit,
			baseSeq: snapshot.baseSeq,
		};
	} catch (err) {
		if (err instanceof AppAccessError) notFound();
		throw err;
	}
	/* `complete` apps open normally, and so does a `generating` build — the
	 * builder hydrates its thread and reconnects to the live stream, so a
	 * refresh mid-build resumes instead of locking the user out. `error`
	 * builds are decided BELOW, off the thread load: a build whose run died
	 * mid-flight (instance kill — the reaper flipped it to `error`, the
	 * thread heal just stripped its dead stream marker) is admitted so the
	 * client can auto-re-drive the interrupted turn; every other error app
	 * still redirects — there is no run to rejoin and no usable app behind
	 * it. */
	if (
		app.status !== "complete" &&
		app.status !== "generating" &&
		app.status !== "error"
	) {
		redirect("/");
	}

	/* Viewers (view-only members) get the read-only builder — every edit
	 * affordance hides and auto-save is suppressed. Editors/admins/owners
	 * edit normally. The write paths enforce this server-side regardless. */
	/* Conversations — the list plus the most recent thread's transcript.
	 * Best-effort for a COMPLETE app (the builder is fully usable without
	 * chat history, so a read fault degrades to an empty conversation, never
	 * a 500). A GENERATING app is different: it was admitted PRECISELY so the
	 * live build resumes, and that resume rides the hydrated thread — landing
	 * without it would show a half-built app with an empty chat and no sign a
	 * build is running, so the degraded path keeps the old redirect. */
	let threads: LoadedThreadMeta[] = [];
	let initialThread: LoadedThread | null = null;
	try {
		threads = await listThreadMetas(id);
		if (threads.length > 0) {
			initialThread = await loadThread(
				id,
				threads[0].thread_id,
				session.user.id,
			);
		}
	} catch (err) {
		log.error("[build-page] thread hydration failed", err, { appId: id });
		if (app.status !== "complete") redirect("/");
	}

	/* An `error` app earns admission ONLY as an interrupted build: the
	 * hydrated thread carries a dead live-stream marker (`loadThread` derives
	 * `resume_interrupted` itself — the detection is level-triggered, so it
	 * doesn't matter which loader read the row first, and a NON-most-recent
	 * interrupted thread keeps its own signal for the Conversations list to
	 * act on). Anything else — a build that failed and finalized cleanly, a
	 * faulted hydration — keeps the old redirect. */
	const buildInterrupted =
		app.status === "error" && initialThread?.resume_interrupted === true;
	if (app.status === "error" && !buildInterrupted) redirect("/");

	return (
		<BuilderProvider
			buildId={id}
			initialDoc={app.blueprint}
			initialAccess={initialAccess}
			userId={session.user.id}
		>
			<BuilderLayout
				isExistingApp
				commcareSettings={commcareSettings}
				impersonating={impersonating}
				threads={threads}
				initialThread={initialThread}
				/* An interrupted build counts: its re-drive must run in build
				 * mode (the claim flips the `error` row back to `generating`). */
				appGenerating={app.status === "generating" || buildInterrupted}
				currentUserId={session.user.id}
			/>
		</BuilderProvider>
	);
}
