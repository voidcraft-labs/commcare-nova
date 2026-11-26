/**
 * The one shape the review and bring-in routes of changes made in CommCare
 * HQ answer in, in two halves, as the bring-in routes of an app do.
 *
 * Before the stream opens: the session, the body read within
 * `HQ_READING_REQUEST_MAX_BYTES`, a strict parse of it with `domain` held to
 * a project space slug, and `edit` on the app. A refusal there is ordinary
 * JSON with a status: 401, 404 and 413 as `handleApiError` answers them, and
 * 400 `invalid_input` with its sentence. Nothing is read of CommCare HQ
 * before all of them pass.
 *
 * Then the stream: 200, one JSON object a line, the service's stage and
 * file events as they come and then exactly one last line, `done` with the
 * service's answer or `failed` where it threw. Every answer of a review and
 * of a bring-in rides that line, never a status. A line written after the
 * client has gone is dropped and never fails the work.
 *
 * No line holds a word of an app, and neither do the logs.
 */

import { z } from "zod";
import {
	HQ_READING_REQUEST_MAX_BYTES,
	handleApiError,
	readJsonBody,
} from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { isValidDomainSlug } from "@/lib/commcare/client";
import { COMMCARE_SERVER_IDS } from "@/lib/commcare/servers";
import { resolveAppScope } from "@/lib/db/appAccess";
import type {
	HqChangesOutcome,
	HqChangesProgress,
	HqChangesReview,
} from "@/lib/deployment/hqChanges";
import {
	LOOKUP_TABLE_CHOICES,
	ownerRuleChoicesSchema,
} from "@/lib/deployment/reading/projectData/reviewTypes";
import { READING_ID_PATTERN } from "@/lib/deployment/reading/types";
import {
	DeploymentSessionEndedError,
	sessionManagementGrant,
} from "@/lib/deployment/sessionManagementGrant";
import type {
	DeploymentScope,
	DeploymentTargetKey,
} from "@/lib/deployment/store";
import { deploymentAppIdSchema } from "@/lib/deployment/types";
import { log } from "@/lib/logger";
import { READING_REFUSAL_COPY } from "@/lib/publish/hqReadingCopy";

const NOT_STORED = "private, no-store";

/** The review route's body: one app's deployment on one project space. */
export const hqChangesKeySchema = z.strictObject({
	appId: deploymentAppIdSchema,
	server: z.enum(COMMCARE_SERVER_IDS),
	domain: z.string(),
});

/** The bring-in route's body: the key, the review it answers, each table's answer and each
 *  owner rule's. */
export const hqChangesBringInSchema = z.strictObject({
	appId: deploymentAppIdSchema,
	server: z.enum(COMMCARE_SERVER_IDS),
	domain: z.string(),
	readingId: z.string().regex(READING_ID_PATTERN),
	reviewDigest: z.string().regex(/^[0-9a-f]{64}$/),
	tableChoices: z.record(z.string(), z.enum(LOOKUP_TABLE_CHOICES)),
	/** The answer for each owner rule the review asks about, by level code. */
	ownerRuleChoices: ownerRuleChoicesSchema.optional(),
});

/** One line of either route's stream. */
export type HqChangesLine =
	| HqChangesProgress
	| {
			readonly type: "done";
			readonly answer: HqChangesReview | HqChangesOutcome;
	  }
	| { readonly type: "failed" };

/** What every body of the two routes names: the app and the project space. */
interface KeyedBody {
	readonly appId: string;
	readonly server: DeploymentTargetKey["server"];
	readonly domain: string;
}

/** One route's half of the shell: its name, its body, and the service it streams. */
export interface HqChangesRoute<Body extends KeyedBody> {
	readonly operation: "review" | "bring-in";
	readonly schema: z.ZodType<Body>;
	readonly run: (
		scope: DeploymentScope,
		target: DeploymentTargetKey,
		body: Body,
		onEvent: (event: HqChangesProgress) => void,
	) => Promise<HqChangesReview | HqChangesOutcome>;
}

/** `<top-level key>: <issue code>` of a parse's first issue. */
function issueOf(issues: readonly z.core.$ZodIssue[]): string {
	const first = issues[0];
	if (first === undefined) return "body: unknown";
	const top = first.path[0];
	return `${typeof top === "string" ? top : "body"}: ${first.code}`;
}

/** Answer one request of changes made in CommCare HQ. */
export async function answerHqChanges<Body extends KeyedBody>(
	req: Request,
	route: HqChangesRoute<Body>,
): Promise<Response> {
	let scope: DeploymentScope;
	let body: Body;
	try {
		const session = await requireSession(req);
		const userId = session.user.id;
		const parsed = route.schema.safeParse(
			await readJsonBody(req, HQ_READING_REQUEST_MAX_BYTES),
		);
		if (!parsed.success || !isValidDomainSlug(parsed.data.domain)) {
			log.warn("[hq-changes] request refused", {
				userId,
				operation: route.operation,
				issue: parsed.success
					? "domain: not_a_project_space"
					: issueOf(parsed.error.issues),
			});
			return Response.json(
				{ error: READING_REFUSAL_COPY.invalid_input, code: "invalid_input" },
				{ status: 400, headers: { "Cache-Control": NOT_STORED } },
			);
		}
		body = parsed.data;
		/* `edit`, as Refresh is: both requests read CommCare HQ with the
		 * member's own key, and a bring-in writes the app. A foreign or a
		 * missing app answers 404 alike. */
		const access = await resolveAppScope(body.appId, userId, "edit");
		scope = {
			appId: body.appId,
			projectId: access.projectId,
			role: access.role,
			actorUserId: userId,
			requireOperation: sessionManagementGrant(userId, session.session.id),
			requireInstallationManagement: sessionManagementGrant(
				session.user.id,
				session.session.id,
			),
		};
	} catch (err) {
		const response = handleApiError(
			err instanceof Error ? err : new Error("Changes request failed"),
		);
		response.headers.set("Cache-Control", NOT_STORED);
		return response;
	}

	const target: DeploymentTargetKey = {
		server: body.server,
		domain: body.domain,
	};
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const write = (line: HqChangesLine) => {
				try {
					controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
				} catch {
					/* The client has gone: the line is dropped and the work goes on. */
				}
			};
			let running: string | null = null;
			try {
				const answer = await route.run(scope, target, body, (event) => {
					if (event.type === "stage") running = event.stage;
					write(event);
				});
				write({ type: "done", answer });
			} catch (error) {
				if (error instanceof DeploymentSessionEndedError) {
					write({
						type: "done",
						answer: { kind: "refused", message: error.message },
					});
					return;
				}
				log.error("[hq-changes] failed", error, {
					appId: scope.appId,
					projectId: scope.projectId,
					userId: scope.actorUserId,
					operation: route.operation,
					phase: running,
				});
				write({ type: "failed" });
			} finally {
				try {
					controller.close();
				} catch {
					/* Already closed: the client went away. */
				}
			}
		},
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "application/x-ndjson; charset=utf-8",
			"Cache-Control": NOT_STORED,
		},
	});
}
