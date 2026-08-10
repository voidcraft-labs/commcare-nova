/**
 * Build page: Server Component that fetches app data and composes the
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
 * The `path` param is NOT read here: all path resolution happens
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
 * back in the conversation the user was in, including a thread whose
 * run is still streaming (the client reconnects to it by thread id).
 *
 * `/build/new` has a second form: `?design=<designSessionId>` reopens a design
 * that has not produced an app yet (§15.9's Resume). It is still the app-less
 * builder — no tree, no Preview — with that design's conversation hydrated and
 * its server-derived stage seeded; a design that has since materialized
 * redirects to its app.
 */

import { notFound, redirect } from "next/navigation";
import { BuilderLayout } from "@/components/builder/BuilderLayout";
import { BuilderProvider } from "@/components/builder/BuilderProvider";
import { readOrchestrationHead } from "@/lib/agent/build/orchestratorState";
import { deriveDesignBuildStage } from "@/lib/agent/build/progress";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import { getSession, resolveActiveProjectId } from "@/lib/auth-utils";
import {
	AppAccessError,
	resolveAuthorizedAppSnapshot,
	resolveProjectAccess,
} from "@/lib/db/appAccess";
import {
	loadDesignSession,
	loadMaterializedSessionForApp,
} from "@/lib/db/designSessions";
import { resolveGenerationTargetScope } from "@/lib/db/generationTargetScope";
import {
	type CommCareSettingsPublic,
	getCommCareSettings,
} from "@/lib/db/settings";
import {
	type LoadedThread,
	type LoadedThreadMeta,
	listThreadMetas,
	loadThread,
} from "@/lib/db/threads";
import type { AppDoc } from "@/lib/db/types";
import { previewProjectSpaceFor } from "@/lib/deployment/previewSpace";
import { toRscSerializableDoc } from "@/lib/doc/ownRecords";
import { log } from "@/lib/logger";

export default async function BuilderPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { id } = await params;

	const session = await getSession();
	if (!session) redirect("/");
	const commcareSettings = await getCommCareSettings(session.user.id);

	if (id === "new") {
		const { design } = await searchParams;
		return typeof design === "string" && design.trim().length > 0
			? await resumedDesignPage(design, session.user.id, commcareSettings)
			: await freshBuildPage(session, commcareSettings);
	}

	/* Project-membership gate (view): any member may open the builder; edit
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
	/* `complete` apps open normally, and so does a `generating` build: the
	 * builder hydrates its thread and reconnects to the live stream, so a
	 * refresh mid-build resumes instead of locking the user out. `error`
	 * builds are decided BELOW, from both thread state and durable design
	 * lineage: an interrupted turn can be re-driven, while a materialized
	 * design remains a usable earlier revision even when a later slice failed. */
	if (
		app.status !== "complete" &&
		app.status !== "generating" &&
		app.status !== "error"
	) {
		redirect("/");
	}

	/* Viewers (view-only members) get the read-only builder: every edit
	 * affordance hides and auto-save is suppressed. Editors/admins/owners
	 * edit normally. The write paths enforce this server-side regardless. */
	/* Conversations: the list plus the most recent thread's transcript.
	 * Best-effort for a COMPLETE app (the builder is fully usable without
	 * chat history, so a read fault degrades to an empty conversation, never
	 * a 500). A GENERATING app is different: it was admitted PRECISELY so the
	 * live build resumes, and that resume rides the hydrated thread, landing
	 * without it would show a half-built app with an empty chat and no sign a
	 * build is running, so the degraded path keeps the old redirect. */
	/* Which project space Preview may say a worker signed into. Resolved
	 * server-side so `commcare_project` is right on the first render rather
	 * than appearing a beat later, and `null` whenever there is no honest
	 * answer (no deployment yet, or several). Started BEFORE the thread
	 * hydration and awaited after it, because the two reads share no data
	 * and a serial await would put one more round trip on every builder
	 * cold load's critical path. Its own error handling lives inside
	 * `previewProjectSpaceFor`, which degrades to `null`, so this promise
	 * cannot reject while it waits. */
	const previewProjectSpacePromise = previewProjectSpaceFor({
		appId: id,
		projectId: initialAccess.projectId,
		role: initialAccess.role,
		actorUserId: session.user.id,
	});

	let threads: LoadedThreadMeta[] = [];
	let initialThread: LoadedThread | null = null;
	try {
		threads = await listThreadMetas({ kind: "app", appId: id });
		if (threads.length > 0) {
			initialThread = await loadThread(
				{ kind: "app", appId: id },
				threads[0].thread_id,
				session.user.id,
			);
		}
	} catch (err) {
		log.error("[build-page] thread hydration failed", err, { appId: id });
		if (app.status !== "complete") redirect("/");
	}

	/* An `error` app is reachable when either its hydrated thread carries a
	 * dead live-stream marker (`loadThread` derives `resume_interrupted`) or a
	 * materialized design session proves sequence 1 already committed. The
	 * former may auto-redrive; the latter simply preserves the usable earlier
	 * revision and its ordinary user-driven continuation path. Other error
	 * apps keep the existing redirect. */
	const buildInterrupted =
		app.status === "error" && initialThread?.resume_interrupted === true;
	const failedMaterializedDesign =
		app.status === "error" ? await loadMaterializedSessionForApp(id) : null;
	const failedMaterializedHead =
		failedMaterializedDesign === null
			? null
			: await readOrchestrationHead(failedMaterializedDesign.id);
	const failedMaterializedStage =
		failedMaterializedDesign === null
			? null
			: deriveDesignBuildStage(
					failedMaterializedDesign,
					failedMaterializedHead,
				);
	if (
		app.status === "error" &&
		!buildInterrupted &&
		failedMaterializedDesign === null
	) {
		redirect("/");
	}
	const buildUnfinished =
		app.status === "generating" ||
		buildInterrupted ||
		failedMaterializedDesign !== null;

	const initialDoc = toRscSerializableDoc(app.blueprint);
	const previewProjectSpace = await previewProjectSpacePromise;

	return (
		<BuilderProvider
			buildId={id}
			initialDoc={initialDoc}
			initialAccess={initialAccess}
			/* An interrupted build counts: its re-drive must run in build
			 * mode (the claim flips the `error` row back to `generating`).
			 * Seeds the session store's `buildUnfinished` latch, the same
			 * value the `appGenerating` prop below carries for mount-time
			 * thread-activation decisions. */
			initialBuildUnfinished={buildUnfinished}
			initialProjectSpace={previewProjectSpace}
			userId={session.user.id}
		>
			<BuilderLayout
				isExistingApp
				commcareSettings={commcareSettings}
				threads={threads}
				initialThread={initialThread}
				appGenerating={buildUnfinished}
				currentUserId={session.user.id}
				initialDesignSession={
					failedMaterializedDesign !== null && failedMaterializedStage !== null
						? {
								designSessionId: failedMaterializedDesign.id,
								materializedAppId: id,
								stage: failedMaterializedStage,
							}
						: undefined
				}
			/>
		</BuilderProvider>
	);
}

/**
 * `/build/new` with nothing to resume. No blueprint and no cursor yet, but a
 * Project authority all the same: creation targets the active Project, so the
 * role is resolved on the server and seeded with `{ baseSeq: 0 }`, and a
 * viewer's first client frame is truthfully read-only rather than editor until
 * the write route refuses them. The reconciler stays dormant until
 * `data-app-materialized`.
 */
async function freshBuildPage(
	session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
	commcareSettings: CommCareSettingsPublic,
) {
	const projectId = await resolveActiveProjectId(session);
	const access = await resolveProjectAccess(session.user.id, projectId, "view");
	return (
		<BuilderProvider
			buildId="new"
			userId={session.user.id}
			initialAccess={{
				projectId,
				role: access.role,
				canEdit: roleAllowsApp(access.role, "edit"),
				baseSeq: 0,
			}}
		>
			<BuilderLayout commcareSettings={commcareSettings} />
		</BuilderProvider>
	);
}

/**
 * `/build/new?design=<id>` — Resume from the Designs-in-progress section
 * (§15.9). Still the app-less builder: the conversation is primary, there is
 * no tree and no Preview, and the only thing carried over from the server is
 * the design's transcript plus the stage its durable orchestration is at.
 *
 * Authorization runs through the shared generation-target resolver, so every
 * denial — unknown id, another tenant's id, an under-privileged member —
 * collapses to the same 404. A session that has since produced an app is not
 * a design in progress any more, so it redirects to that app rather than
 * offering a second surface onto it.
 */
async function resumedDesignPage(
	designSessionId: string,
	userId: string,
	commcareSettings: CommCareSettingsPublic,
) {
	let scope: Awaited<ReturnType<typeof resolveGenerationTargetScope>>;
	try {
		scope = await resolveGenerationTargetScope(
			{ kind: "design-session", designSessionId },
			userId,
			"view",
		);
	} catch (err) {
		if (err instanceof AppAccessError) notFound();
		throw err;
	}
	if (scope.appId !== null) redirect(`/build/${scope.appId}`);
	if (scope.state !== "active") notFound();

	/* The session row and its orchestration head are the two durable facts the
	 * stage folds from; the outline and build plan live only in the frames a
	 * run streams, so a cold load deliberately shows the stage alone rather
	 * than a reconstructed card. */
	const designSession = await loadDesignSession(designSessionId);
	if (designSession?.mode !== "build") notFound();
	const orchestrationHead = await readOrchestrationHead(designSessionId);
	const stage = deriveDesignBuildStage(designSession, orchestrationHead);

	const target = { kind: "design-session", designSessionId } as const;
	let threads: LoadedThreadMeta[] = [];
	let initialThread: LoadedThread | null = null;
	try {
		threads = await listThreadMetas(target);
		if (threads.length > 0) {
			initialThread = await loadThread(target, threads[0].thread_id, userId);
		}
	} catch (err) {
		/* A design IS its conversation — there is no tree, no Preview, and no
		 * document to fall back on — so a failed hydration has nothing left to
		 * render. Go back to the list, where the design is still listed and
		 * still resumable, rather than showing an empty room. */
		log.error("[build-page] design thread hydration failed", err, {
			designSessionId,
		});
		redirect("/");
	}

	return (
		<BuilderProvider
			buildId="new"
			userId={userId}
			initialAccess={{
				projectId: scope.projectId,
				role: scope.role,
				canEdit: roleAllowsApp(scope.role, "edit"),
				baseSeq: 0,
			}}
			/* No app row exists, so nothing about this session is "complete":
			 * every send continues the build. */
			initialBuildUnfinished
		>
			<BuilderLayout
				commcareSettings={commcareSettings}
				threads={threads}
				initialThread={initialThread}
				currentUserId={userId}
				initialDesignSession={{
					designSessionId,
					materializedAppId: null,
					stage,
				}}
			/>
		</BuilderProvider>
	);
}
