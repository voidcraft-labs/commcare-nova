/**
 * CommCare HQ's answers to the cutover's reads, as the proof lane retained
 * them under `proof/hq-reads/cutover/` (`proof/hq/test_retained_reads.py`,
 * its `cutover` group): for each fixture document, the source reads and the
 * form id reads after its legacy create and after its legacy republish, and
 * HQ's refusals under `answers/`. Each file is `{ status, headers, body }`.
 * A test serves them to the real client code through a peer, so what it
 * proves is Nova's reading of HQ's own answers.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedHqAnswer,
	replyRetained,
} from "@/__tests__/helpers/retainedHqReads";
import { type HqAppSource, readHqAppSource } from "@/lib/commcare/hq/appSource";
import type { CommCareCredentials } from "@/lib/commcare/hq/http";
import {
	classifySourceRead,
	type HqReadOutcome,
	readHqApplicationFormIds,
} from "../../hqRead";
import type { HqFormIdModule } from "../../matching";
import { LEGACY_DIRECTORY } from "./preStep";

export const PEER_HOST = "https://www.commcarehq.org";
export const PEER_DOMAIN = "nova-proof";
export const PEER_APP = "retained-app";
export const SOURCE_PATH = `/a/${PEER_DOMAIN}/apps/source/${PEER_APP}/`;
export const FORM_IDS_PATH = `/a/${PEER_DOMAIN}/api/v0.4/application/${PEER_APP}/`;

export const PEER_CREDENTIALS: CommCareCredentials = {
	username: "member@example.org",
	apiKey: "retained-key",
	server: "production",
};

/** The two states each fixture's legacy uploads leave HQ in. */
export type RetainedState = "after-create" | "after-republish";

/** One retained answer, by its path under `proof/hq-reads/cutover/`. */
export function retainedCutoverRead(...segments: string[]): RetainedHqAnswer {
	const raw = JSON.parse(
		readFileSync(join(LEGACY_DIRECTORY, ...segments), "utf8"),
	) as { status: number; headers?: Record<string, string>; body?: unknown };
	return { status: raw.status, headers: raw.headers ?? {}, body: raw.body };
}

/** The answer's body as a JSON value. */
export function bodyJson(answer: RetainedHqAnswer): Record<string, unknown> {
	const value =
		typeof answer.body === "string" ? JSON.parse(answer.body) : answer.body;
	return value as Record<string, unknown>;
}

/** The answer with its body replaced, for a test that edits one key of it. */
export function withBody(
	answer: RetainedHqAnswer,
	body: unknown,
): RetainedHqAnswer {
	return { ...answer, body };
}

/** A retained source answer read by `readHqAppSource`, through a peer. */
export async function readRetainedSource(
	answer: RetainedHqAnswer,
): Promise<HqReadOutcome<HqAppSource>> {
	return withHttpPeer(async (peer) => {
		replyRetained(
			peer.get(PEER_HOST).intercept({ path: SOURCE_PATH, method: "GET" }),
			answer,
		);
		return classifySourceRead(
			await readHqAppSource(PEER_CREDENTIALS, PEER_DOMAIN, PEER_APP),
		);
	});
}

/** A retained form id answer read by `readHqApplicationFormIds`, through a peer. */
export async function readRetainedFormIds(
	answer: RetainedHqAnswer,
): Promise<HqReadOutcome<HqFormIdModule[]>> {
	return withHttpPeer(async (peer) => {
		replyRetained(
			peer.get(PEER_HOST).intercept({ path: FORM_IDS_PATH, method: "GET" }),
			answer,
		);
		return readHqApplicationFormIds(PEER_CREDENTIALS, PEER_DOMAIN, PEER_APP);
	});
}

/** The source a retained answer reads as, where it reads as one. */
export async function retainedSource(
	answer: RetainedHqAnswer,
): Promise<HqAppSource> {
	const outcome = await readRetainedSource(answer);
	if (outcome.kind !== "ok") {
		throw new Error(`The retained source read answered ${outcome.kind}.`);
	}
	return outcome.value;
}

/** The form id modules a retained answer reads as, where it reads as them. */
export async function retainedFormIds(
	answer: RetainedHqAnswer,
): Promise<HqFormIdModule[]> {
	const outcome = await readRetainedFormIds(answer);
	if (outcome.kind !== "ok") {
		throw new Error(`The retained form id read answered ${outcome.kind}.`);
	}
	return outcome.value;
}
