/**
 * Which project spaces hold a copy of this app that changed in CommCare HQ:
 * POST /api/commcare/changes/check, body `{ appId }`.
 *
 * The builder asks once each time it opens an app, after it is drawn, by a
 * plain `fetch` no render and no edit waits on. It authorizes `edit`, as
 * Refresh does, because it reads CommCare HQ with the member's own key, and
 * answers 200 with `{ changed: { server, domain }[] }` for every outcome past
 * authorization, an empty list included: a check that fails says nothing to
 * the person, and the service's warn is its only trace. It writes nothing,
 * and the request's own signal stops the reads when the builder goes.
 *
 * A route and not a Server Action: a tab's actions run one at a time, and
 * this one waits on CommCare HQ.
 */

import { z } from "zod";
import { handleApiError, readJsonBody } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { resolveAppScope } from "@/lib/db/appAccess";
import { checkHqChangesForApp } from "@/lib/deployment/hqChanges";
import type { DeploymentScope } from "@/lib/deployment/store";
import { deploymentAppIdSchema } from "@/lib/deployment/types";
import { log } from "@/lib/logger";
import { READING_REFUSAL_COPY } from "@/lib/publish/hqReadingCopy";

const NOT_STORED = "private, no-store";

/** The largest body this route reads: an app id and its key. */
const CHECK_REQUEST_MAX_BYTES = 1024;

const checkBodySchema = z.strictObject({ appId: deploymentAppIdSchema });

export async function POST(req: Request): Promise<Response> {
	let scope: DeploymentScope;
	try {
		const session = await requireSession(req);
		const parsed = checkBodySchema.safeParse(
			await readJsonBody(req, CHECK_REQUEST_MAX_BYTES),
		);
		if (!parsed.success)
			return Response.json(
				{
					error: READING_REFUSAL_COPY.invalid_input,
					code: "invalid_input",
				},
				{ status: 400, headers: { "Cache-Control": NOT_STORED } },
			);
		const access = await resolveAppScope(
			parsed.data.appId,
			session.user.id,
			"edit",
		);
		scope = {
			appId: parsed.data.appId,
			projectId: access.projectId,
			role: access.role,
			actorUserId: session.user.id,
		};
	} catch (err) {
		const response = handleApiError(
			err instanceof Error ? err : new Error("Changes check failed"),
		);
		response.headers.set("Cache-Control", NOT_STORED);
		return response;
	}

	let changed: readonly { server: string; domain: string }[] = [];
	try {
		changed = (await checkHqChangesForApp(scope, { cancel: req.signal })).map(
			(target) => ({ server: target.server, domain: target.domain }),
		);
	} catch {
		log.warn("[hq-changes] check failed", { appId: scope.appId });
	}
	return Response.json(
		{ changed },
		{ headers: { "Cache-Control": NOT_STORED } },
	);
}
