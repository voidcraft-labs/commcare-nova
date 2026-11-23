import "server-only";
import type { HqManagementGrant } from "../store";

/**
 * One read of a CommCare HQ app for review: who may ask for it, and the read
 * itself. A read writes nothing: it mints a reading's id, derives the app's
 * id from it, gathers, and answers a stop, an account or a review.
 */

import { v7 as uuidv7 } from "uuid";
import { AppAccessError, resolveProjectAccess } from "@/lib/db/appAccess";
import { log } from "@/lib/logger";
import { broughtInAppId } from "./appId";
import { type GatherFacts, type GatherResult, gatherReading } from "./gather";
import { noRoomFinding, withBringInRoom } from "./room";
import type { ReadingAnswer, ReadingEvent, ReadingKey } from "./types";

declare const bringInAuthorized: unique symbol;

/** Proof that the person held `edit` in the Project when the request began. Only
 *  `authorizeBringIn` makes one: the brand's key is not exported. */
export interface BringInActor {
	readonly requireOperation?: HqManagementGrant;
	readonly userId: string;
	readonly role: string;
	readonly projectId: string;
	readonly [bringInAuthorized]: true;
}

/**
 * `lib/db/appAccess.ts::resolveProjectAccess(userId, projectId, "edit")`.
 * Null where it refuses. A read needs `edit` although it writes nothing,
 * because it reads the Project's own side of the lookup tables the app reads.
 */
export async function authorizeBringIn(
	userId: string,
	projectId: string,
): Promise<BringInActor | null> {
	try {
		const { role } = await resolveProjectAccess(userId, projectId, "edit");
		return { userId, projectId, role } as BringInActor;
	} catch (error) {
		if (error instanceof AppAccessError) return null;
		throw error;
	}
}

/**
 * One whole read. Mints the reading's id, derives the app's, and answers. Writes nothing.
 * Where the process has no room for what it reads (`room.ts`), it stops reading and answers
 * `nova-busy`.
 */
export function readHqAppForReview(
	actor: BringInActor,
	key: ReadingKey,
	options: {
		readonly onEvent: (event: ReadingEvent) => void;
		readonly cancel?: AbortSignal;
		readonly continuationReadingId?: string;
	},
): Promise<ReadingAnswer> {
	return withBringInRoom(
		"review",
		(room) =>
			readInRoom(actor, key, {
				onEvent: options.onEvent,
				continuationReadingId: options.continuationReadingId,
				cancel:
					options.cancel === undefined
						? room.signal
						: AbortSignal.any([options.cancel, room.signal]),
			}),
		() => ({ kind: "stop", finding: noRoomFinding() }),
	);
}

async function readInRoom(
	actor: BringInActor,
	key: ReadingKey,
	options: {
		readonly onEvent: (event: ReadingEvent) => void;
		readonly cancel?: AbortSignal;
		readonly continuationReadingId?: string;
	},
): Promise<ReadingAnswer> {
	const started = performance.now();
	const readingId = options.continuationReadingId ?? uuidv7();
	const appId = broughtInAppId(actor.userId, key, readingId);
	const { result, facts } = await gatherReading({
		actor,
		key,
		readingId,
		appId,
		keepMedia: false,
		onEvent: options.onEvent,
		...(options.cancel !== undefined && { cancel: options.cancel }),
	});
	const answer = answerOf(result, readingId);
	logAnswered(answer, facts, {
		appId,
		projectId: key.projectId,
		userId: actor.userId,
		elapsedMs: performance.now() - started,
	});
	return answer;
}

/** The answer a gathered result gives: a stop or an account as gathered, or the review with
 *  the reading's id and digest, the gathered values dropped. */
function answerOf(result: GatherResult, readingId: string): ReadingAnswer {
	switch (result.kind) {
		case "stop":
			return { kind: "stop", finding: result.finding };
		case "account":
			return result.account;
		case "clean":
			return {
				kind: "review",
				readingId,
				reviewDigest: result.gathered.reviewDigest,
				review: result.gathered.review,
			};
	}
}

/** The request's lines: one `[reading] answered`, and a `[reading] stopped` beside a stop. No
 *  line holds the project space, the HQ app, or a finding's place or words. */
function logAnswered(
	answer: ReadingAnswer,
	facts: GatherFacts,
	scope: {
		readonly appId: string;
		readonly projectId: string;
		readonly userId: string;
		readonly elapsedMs: number;
	},
): void {
	const identity = {
		appId: scope.appId,
		projectId: scope.projectId,
		userId: scope.userId,
		operation: "read",
	};
	if (answer.kind === "stop")
		log.warn("[reading] stopped", { ...identity, phase: answer.finding.code });
	log.info("[reading] answered", {
		...identity,
		phase: answer.kind,
		elapsedMs: Math.round(scope.elapsedMs),
		checkMs: Math.round(facts.checkMs),
		longestPieceMs: Math.round(facts.longestPieceMs),
		workUnits: facts.workUnits,
		longestPieceUnits: facts.longestPieceUnits,
		sourceBytes: facts.sourceBytes,
		mediaTotal: facts.mediaTotal,
		...(answer.kind === "account" && {
			findingCount: answer.findings.length + answer.more,
			codeCount: new Set(answer.findings.map((finding) => finding.code)).size,
			notYet: answer.counts.notYet,
			never: answer.counts.never,
			fixInHq: answer.counts.fixInHq,
		}),
		...(facts.expressionRounds !== null && {
			expressionRounds: facts.expressionRounds,
		}),
	});
}
