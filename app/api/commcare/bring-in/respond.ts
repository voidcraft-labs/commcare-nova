/**
 * The one shape both bring-in routes answer in, in two halves.
 *
 * Before the stream opens: the session, the body read within
 * `HQ_READING_REQUEST_MAX_BYTES`, a strict parse of it with `domain` held to
 * a project space slug, and `authorizeBringIn`. A refusal there is ordinary
 * JSON with a status: 401, 413 and 499 as `handleApiError` answers them, 400
 * `invalid_input` and 403 `no_project_access` with the refusal's sentence
 * beside its code. Nothing is read of CommCare HQ before all of them pass.
 *
 * Then the stream: 200, one JSON object a line, the service's stage and file
 * events as they come and then exactly one last line, `done` with the
 * service's answer or `failed` where it threw. A stop, an account, a review
 * and a create that did not create are all answers on that line, never
 * statuses. A line written after the client has gone is dropped and never
 * fails the work: a read then stops by its `cancel`, and a create runs on.
 *
 * A stage line names a stage and a files line holds two counts, but the `done`
 * line carries the service's answer, which holds the app's own words (its
 * name, its case types, a created app's whole blueprint), so no stream line
 * is ever logged. No log line holds a word of an app: a refused body is
 * logged by its first issue's top-level key and code, never a deeper path or
 * a value, and a failure by the stage that was running.
 */

import type { z } from "zod";
import {
	HQ_READING_REQUEST_MAX_BYTES,
	handleApiError,
	readJsonBody,
} from "@/lib/apiError";
import { DeploymentSessionEndedError, sessionManagementGrant } from "@/lib/deployment/sessionManagementGrant";
import type { HqManagementGrant } from "@/lib/deployment/store";
import { requireSession } from "@/lib/auth-utils";
import { isValidDomainSlug } from "@/lib/commcare/client";
import type {
	CreateAnswer,
	ReadingAnswer,
	ReadingEvent,
	ReadingRefusal,
	ReadingStage,
} from "@/lib/deployment";
import { authorizeBringIn, type BringInActor } from "@/lib/deployment/reading";
import { READING_REFUSAL_STATUS } from "@/lib/deployment/reading/types";
import { log } from "@/lib/logger";
import { READING_REFUSAL_COPY } from "@/lib/publish/hqReadingCopy";

const NOT_STORED = "private, no-store";

/** One route's half of the shell: its name, its body, and the service it streams. */
export interface BringInRoute<
	Body extends { projectId: string; domain: string },
> {
	readonly operation: "read" | "create";
	readonly schema: z.ZodType<Body>;
	/** The derived app id of the request, where the route can know it before the service runs. */
	readonly appIdOf: (userId: string, body: Body) => string | null;
	readonly run: (
		actor: BringInActor,
		body: Body,
		onEvent: (event: ReadingEvent) => void,
		requireInstallationManagement: HqManagementGrant,
	) => Promise<ReadingAnswer | CreateAnswer>;
}

/** A refusal answered before any stream opens, with its sentence and its code. */
function refused(refusal: ReadingRefusal): Response {
	return Response.json(
		{ error: READING_REFUSAL_COPY[refusal], code: refusal },
		{
			status: READING_REFUSAL_STATUS[refusal],
			headers: { "Cache-Control": NOT_STORED },
		},
	);
}

/** `<top-level key>: <issue code>` of a parse's first issue. A key of a record (a table's
 *  tag) is below the top level, and the body itself has no key. */
function issueOf(issues: readonly z.core.$ZodIssue[]): string {
	const first = issues[0];
	if (first === undefined) return "body: unknown";
	const top = first.path[0];
	return `${typeof top === "string" ? top : "body"}: ${first.code}`;
}

/** Answer one bring-in request. */
export async function answerBringIn<
	Body extends { projectId: string; domain: string },
>(req: Request, route: BringInRoute<Body>): Promise<Response> {
	let userId: string;
	let body: Body;
	let actor: BringInActor;
	let grant: HqManagementGrant;
	try {
		const session = await requireSession(req);
		userId = session.user.id;
		const parsed = route.schema.safeParse(
			await readJsonBody(req, HQ_READING_REQUEST_MAX_BYTES),
		);
		if (!parsed.success || !isValidDomainSlug(parsed.data.domain)) {
			log.warn("[reading] request refused", {
				userId,
				operation: route.operation,
				phase: route.operation,
				issue: parsed.success
					? "domain: not_a_project_space"
					: issueOf(parsed.error.issues),
			});
			return refused("invalid_input");
		}
		body = parsed.data;
		const authorized = await authorizeBringIn(userId, body.projectId);
		if (authorized === null) return refused("no_project_access");
		actor = authorized;
		grant = sessionManagementGrant(userId, session.session.id);
	} catch (err) {
		const response = handleApiError(
			err instanceof Error ? err : new Error("Bring-in request failed"),
		);
		response.headers.set("Cache-Control", NOT_STORED);
		return response;
	}

	const appId = route.appIdOf(userId, body);
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const write = (line: ReadingEvent) => {
				try {
					controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
				} catch {
					/* The client has gone: the line is dropped and the work goes on. */
				}
			};
			let running: ReadingStage | null = null;
			try {
				const answer = await route.run(actor, body, (event) => {
					/* The last line is this shell's alone, so a service's own can never
					 * make a second one. */
					if (event.type !== "stage" && event.type !== "files") return;
					if (event.type === "stage") running = event.stage;
					write(event);
				}, grant);
				write({ type: "done", answer });
			} catch (error) {
				if (error instanceof DeploymentSessionEndedError) {
					write({ type: "done", answer: { kind: "refused", refusal: "session_ended" } });
					return;
				}
				log.error("[reading] failed", error, {
					...(appId !== null && { appId }),
					projectId: body.projectId,
					userId,
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
