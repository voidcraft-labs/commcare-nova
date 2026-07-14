/**
 * Build page — Server Component that fetches app data and composes the
 * client-side builder tree.
 *
 * This page uses an optional catch-all route (`[[...path]]`) so Next.js
 * serves the same RSC page for all intra-builder paths:
 *   /build/{id}              → home
 *   /build/{id}/{uuid}       → module or form
 *   /build/{id}/{uuid}/{uuid} → form + selected field
 *   /build/{id}/{uuid}/cases  → case list
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
import { getSession } from "@/lib/auth-utils";
import { AppAccessError, resolveAppAccess } from "@/lib/db/appAccess";
import {
	type CommCareSettingsPublic,
	getCommCareSettings,
} from "@/lib/db/settings";
import { listThreadMetas, loadThread } from "@/lib/db/threads";
import type { AppDoc, ThreadDoc, ThreadMeta } from "@/lib/db/types";
import { log } from "@/lib/logger";

export default async function BuilderPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;

	const session = await getSession();
	const commcareSettings = session
		? await getCommCareSettings(session.user.id)
		: ({ configured: false } satisfies CommCareSettingsPublic);

	/* During impersonation, session.user is the target — surface their
	 * identity so BuilderHeader shows the banner, mirroring the site
	 * header in `(site)/layout.tsx`. */
	const impersonating = session?.session?.impersonatedBy
		? { userName: session.user.name, userEmail: session.user.email }
		: null;

	/* New apps — no blueprint fetch needed. The reconciler mounts dormant
	 * (no appId yet) and activates when the run mints one via `data-app-id`;
	 * still pass the user id so echo classification works once it activates. */
	if (id === "new") {
		return (
			<BuilderProvider buildId={id} userId={session?.user.id}>
				<BuilderLayout
					commcareSettings={commcareSettings}
					impersonating={impersonating}
				/>
			</BuilderProvider>
		);
	}

	if (!session) redirect("/");

	/* Project-membership gate (view) — any member may open the builder; edit
	 * is enforced at the write paths (PUT / chat / MCP). Denials collapse to
	 * notFound() to avoid leaking another Project's app. */
	let app: AppDoc;
	let role: string;
	try {
		const access = await resolveAppAccess(id, session.user.id, "view");
		app = access.app;
		role = access.role;
	} catch (err) {
		if (err instanceof AppAccessError) notFound();
		throw err;
	}
	/* `complete` apps open normally, and so does a `generating` build — the
	 * builder hydrates its thread and reconnects to the live stream, so a
	 * refresh mid-build resumes instead of locking the user out. Only
	 * `error` builds redirect: there is no run to rejoin and no usable app
	 * behind them. */
	if (app.status !== "complete" && app.status !== "generating") redirect("/");

	/* Viewers (view-only members) get the read-only builder — every edit
	 * affordance hides and auto-save is suppressed. Editors/admins/owners
	 * edit normally. The write paths enforce this server-side regardless. */
	const canEdit = roleAllowsApp(role, "edit");

	/* Conversations — the list plus the most recent thread's transcript.
	 * Best-effort: the builder is fully usable without chat history, so a
	 * thread-read fault degrades to an empty conversation, never a 500. */
	let threads: ThreadMeta[] = [];
	let initialThread: ThreadDoc | null = null;
	try {
		threads = await listThreadMetas(id);
		if (threads.length > 0) {
			initialThread = await loadThread(id, threads[0].thread_id);
		}
	} catch (err) {
		log.error("[build-page] thread hydration failed", err, { appId: id });
	}

	return (
		<BuilderProvider
			buildId={id}
			initialDoc={app.blueprint}
			canEdit={canEdit}
			baseSeq={app.mutation_seq}
			userId={session.user.id}
		>
			<BuilderLayout
				isExistingApp
				commcareSettings={commcareSettings}
				impersonating={impersonating}
				threads={threads}
				initialThread={initialThread}
			/>
		</BuilderProvider>
	);
}
