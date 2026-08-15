/**
 * The ONE shared resolver boundary for generation-target authorization
 * (§11.1). Every surface that answers "may this caller touch this target,
 * and in which Project" resolves through here: thread target checks, stream
 * reconnect authorization, and post-materialization app resolution. No
 * caller open-codes `if (appId) … else …` authorization, and every denial —
 * a missing id, a foreign-Project id, an under-privileged member —
 * collapses to the same opaque `AppAccessError("not_found")` shape the app
 * routes have always used, so a cross-tenant probe learns nothing.
 *
 * Kept SEPARATE from `generationTargets.ts` on purpose: that module is a
 * dependency-free type leaf imported across the whole protocol layer
 * (threads, streams, usage, run summaries, the agent contexts), while this
 * one reaches the run-protocol stack (`apps`, `designSessions`, and through
 * them the commit kernel). Folding the resolver into the leaf drags that
 * stack into every type-consumer's import graph — which is exactly the
 * shape that deadlocked the agent media suites' mocked-module factories
 * (a `vi.mock` factory's dynamic import re-entered a module still
 * evaluating in the same graph).
 */

import type { AppCapability } from "@/lib/auth/projectRoles";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import { AppAccessError, resolveAppScope } from "./appAccess";
import { appHeldLive } from "./apps";
import {
	type DesignSessionDoc,
	designSessionHeldLive,
	loadDesignSession,
} from "./designSessions";
import type { GenerationTarget } from "./generationTargets";
import { projectRoleFor } from "./projectMembership";

/** A resolved, authorized generation target. `appId` is the app that carries
 * (or shares) run authority: the app target itself, or a materialized /
 * completed / edit session's bound app; null for a pre-app build session.
 * `state` is the session lifecycle; an app target always reads `active`. */
export interface ResolvedGenerationTarget {
	readonly target: GenerationTarget;
	readonly projectId: string;
	readonly role: string;
	readonly actorUserId: string;
	readonly appId: string | null;
	readonly state: "active" | "materialized" | "completed" | "abandoned";
}

/**
 * Resolve + authorize one generation target at the `required` capability.
 * Throws {@link AppAccessError} on every denial (opaque not-found posture).
 *
 * A design session authorizes against ITS Project membership; a MATERIALIZED
 * (or completed edit) session additionally surfaces its bound app so run
 * authority can delegate to the app's current Project — the session's
 * `project_id` follows the app on a Project move (`§18.14`), so the two
 * agree by construction.
 */
export async function resolveGenerationTargetScope(
	target: GenerationTarget,
	userId: string,
	required: AppCapability = "view",
): Promise<ResolvedGenerationTarget> {
	if (target.kind === "app") {
		const scope = await resolveAppScope(target.appId, userId, required);
		return {
			target,
			projectId: scope.projectId,
			role: scope.role,
			actorUserId: userId,
			appId: target.appId,
			state: "active",
		};
	}
	const session = await loadDesignSession(target.designSessionId);
	if (!session) throw new AppAccessError("not_found");
	/* Before materialization the design is owner-private even inside a shared
	 * Project. The app becomes the Project-shared authority boundary only once
	 * the session has a bound app. Collapse this denial with every other
	 * cross-tenant probe. */
	if (session.app_id === null && session.owner_user_id !== userId) {
		throw new AppAccessError("not_found");
	}
	const role = await projectRoleFor(userId, session.project_id);
	if (role === null) throw new AppAccessError("not_member");
	if (!roleAllowsApp(role, required)) {
		throw new AppAccessError("insufficient_role");
	}
	return {
		target,
		projectId: session.project_id,
		role,
		actorUserId: userId,
		appId: session.app_id,
		state: session.state,
	};
}

/**
 * Whether ANY run currently holds this target live — the stream endpoint's
 * dead-run fallback signal, target-polymorphic (`appHeldLive` /
 * `designSessionHeldLive`). Read-only.
 *
 * Run authority delegates to a bound app exactly as the thread writers'
 * lock order does (§11.7): a session that carries an `app_id` — a
 * materialized build whose run transferred its holder to the app row, or an
 * edit session whose app was always the sole authority — answers with the
 * APP's liveness. A stream keeps its design-session target for its whole
 * life, so without the delegation a reconnect after materialization would
 * read the terminal session row and cut a still-live run's tail.
 */
export async function generationTargetHeldLive(
	target: GenerationTarget,
): Promise<boolean> {
	if (target.kind === "app") return appHeldLive(target.appId);
	const session = await loadDesignSession(target.designSessionId);
	if (!session) return false;
	if (session.app_id !== null) return appHeldLive(session.app_id);
	return designSessionHeldLive(target.designSessionId);
}

/** Load the design session behind a target, for callers that already
 * authorized it and need the session's lifecycle columns. */
export async function loadResolvedDesignSession(
	target: GenerationTarget,
): Promise<DesignSessionDoc | null> {
	return target.kind === "design-session"
		? loadDesignSession(target.designSessionId)
		: null;
}
