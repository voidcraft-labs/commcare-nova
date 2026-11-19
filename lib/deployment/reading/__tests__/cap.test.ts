/**
 * A bring-in's read at the byte cap, over `gatherFromHq` with a Project side
 * that holds nothing and CommCare HQ answering on a loopback socket.
 *
 * A body held or parsed past the bound, a read whose work passes the work
 * meter's limit of its size, and a synchronous piece that does more of the
 * read than its share between two turns of the event loop are what these
 * cases catch. The work is counted by the meter (`workMeter.ts`), the same
 * on every machine; the wall time of the longest piece is logged, so a
 * hosted runner's log shows it, and fails the case only at four times the
 * five seconds a piece is meant to take. A failure of the last case is fixed
 * in the reader or in acceptance, by cutting the piece where it is long; the
 * cap stands.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { withSocketHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedHqAnswer,
	retainedBodyJson,
	retainedBodyText,
	retainedGroupRead,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { HQ_BRING_IN_APP_MAX_BYTES } from "@/lib/commcare/hq/appReading";
import { readWorkLimit, sourceCharacters } from "@/lib/commcare/reader/work";
import type { LookupRevision } from "@/lib/lookup/types";
import { type GatherResult, gatherFromHq } from "../gather";
import type { ReadingProjectSide } from "../projectData/read";
import type { ReadingEvent } from "../types";

const HOSTNAME = "india.commcarehq.org";
const DOMAIN = "clinic";
const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const APP = retainedBodyJson(retainedReadingRead("application")).id as string;
const KEY = {
	projectId: "cap-project",
	server: "india",
	domain: DOMAIN,
	remoteAppId: APP,
} as const;
const READING_ID = "019a7f3c-2b1d-7e40-8a9b-0c1d2e3f4a5b";
const APP_ID = "5b0c8d6e-2f1a-4c3b-9e7d-6a5b4c3d2e1f";

const PATHS = {
	application: `/a/${DOMAIN}/api/application/v1/${APP}/`,
	source: `/a/${DOMAIN}/apps/source/${APP}/`,
	version: `/a/${DOMAIN}/apps/view/${APP}/current_version/`,
	tables: `/a/${DOMAIN}/api/lookup_table/v1/?limit=1000`,
};

/** A Project that holds no table, as the proof lane's reading binds it. */
const NOTHING: ReadingProjectSide = {
	tables: async () => ({
		projectId: KEY.projectId,
		projectRevision: "0" as LookupRevision,
		definitions: [],
		rowsByTable: {},
		keptColumns: {},
	}),
	referencingApps: async () => ({}),
	siblings: async () => [],
	mayAdminister: async () => true,
	measureRows: async () => ({ dataBytes: 0, largestRowBytes: 0 }),
};

/** CommCare HQ's list of lookup tables, holding none. */
function noTables(): RetainedHqAnswer {
	const answer = retainedGroupRead("lookups/lookup-tables");
	const body = retainedBodyJson(answer);
	return {
		...answer,
		body: JSON.stringify({
			...body,
			meta: { ...(body.meta as object), total_count: 0 },
			objects: [],
		}),
	};
}

function send(response: ServerResponse, answer: RetainedHqAnswer): void {
	response.writeHead(answer.status, { ...answer.headers });
	response.end(retainedBodyText(answer));
}

/**
 * A JSON body one byte over the cap, written and never ended, so only a
 * reader that stops at the bound answers. Resolves once the reader has
 * closed the stream, with whether the peer had finished it.
 */
function overTheCap(response: ServerResponse): Promise<{ ended: boolean }> {
	const closed = Promise.withResolvers<{ ended: boolean }>();
	response.on("close", () =>
		closed.resolve({ ended: response.writableFinished }),
	);
	response.writeHead(200, { "content-type": "application/json" });
	const lead = '{"padding": "';
	response.write(
		lead + "x".repeat(HQ_BRING_IN_APP_MAX_BYTES + 1 - lead.length),
	);
	return closed.promise;
}

async function gather(): Promise<{
	readonly result: GatherResult;
	readonly facts: Awaited<ReturnType<typeof gatherFromHq>>["facts"];
	readonly events: readonly ReadingEvent[];
}> {
	const events: ReadingEvent[] = [];
	const { result, facts } = await gatherFromHq({
		key: KEY,
		readingId: READING_ID,
		appId: APP_ID,
		keepMedia: false,
		onEvent: (event) => events.push(event),
		creds: CREDS,
		project: NOTHING,
	});
	return { result, facts, events };
}

/** `ids` with the first eight hex digits of each replaced by `index`, in the id's own case. */
function freshened(text: string, ids: readonly string[], index: number) {
	let out = text;
	for (const id of ids) {
		const digits = index.toString(16).padStart(8, "0");
		const lead =
			id.slice(0, 8) === id.slice(0, 8).toUpperCase()
				? digits.toUpperCase()
				: digits;
		out = out.split(id).join(lead + id.slice(8));
	}
	return out;
}

/**
 * The application resource and the source of `navigation-base`, its one menu
 * repeated under fresh ids until the source is as near the cap as one more
 * menu allows.
 */
function nearTheCap(): {
	readonly application: RetainedHqAnswer;
	readonly source: RetainedHqAnswer;
	readonly menus: number;
} {
	const retainedApplication = retainedReadingRead("application");
	const application = retainedBodyJson(retainedApplication);
	const retainedSource = retainedGroupRead("navigation-base/app-source");
	const source = retainedBodyJson(retainedSource);
	const [summary] = application.modules as Record<string, unknown>[];
	const [menu] = source.modules as Record<string, unknown>[];
	const attachments = source._attachments as Record<string, string>;
	const sourceForms = (
		menu.forms as { unique_id: string; xmlns: string }[]
	).map((form) => form.unique_id);
	const summaryForms = (
		summary.forms as { unique_id: string; xmlns: string }[]
	).map((form) => form.unique_id);
	const xmlnsIds = (summary.forms as { xmlns: string }[]).map((form) =>
		form.xmlns.slice(form.xmlns.lastIndexOf("/") + 1),
	);
	const ids = [
		menu.unique_id as string,
		...sourceForms,
		...summaryForms,
		...xmlnsIds,
	];
	const menuText = JSON.stringify(menu);
	const summaryText = JSON.stringify(summary);
	const attachmentTexts = sourceForms.map((id) => attachments[`${id}.xml`]);
	const perMenu =
		Buffer.byteLength(menuText) +
		attachmentTexts.reduce(
			(sum, text) => sum + Buffer.byteLength(JSON.stringify(text)) + 40,
			0,
		);
	const base = Buffer.byteLength(
		JSON.stringify({ ...source, modules: [], _attachments: {} }),
	);
	const menus = Math.floor(
		(HQ_BRING_IN_APP_MAX_BYTES - base - 4096) / (perMenu + 2),
	);
	const modules: unknown[] = [];
	const summaries: unknown[] = [];
	const held: Record<string, string> = {};
	for (let index = 0; index < menus; index += 1) {
		modules.push(JSON.parse(freshened(menuText, ids, index)));
		summaries.push(JSON.parse(freshened(summaryText, ids, index)));
		sourceForms.forEach((id, position) => {
			held[`${freshened(id, ids, index)}.xml`] = freshened(
				attachmentTexts[position] as string,
				ids,
				index,
			);
		});
	}
	const sourceBody = JSON.stringify({
		...source,
		modules,
		_attachments: held,
	});
	if (Buffer.byteLength(sourceBody) > HQ_BRING_IN_APP_MAX_BYTES)
		throw new Error("The built source is over the cap.");
	return {
		application: {
			...retainedApplication,
			body: JSON.stringify({ ...application, modules: summaries }),
		},
		source: { ...retainedSource, body: sourceBody },
		menus,
	};
}

/**
 * The most units of work one synchronous piece of a read at the cap does: four times the
 * 911,157 units the read's most piece did, part of the reading, when the work meter was set,
 * rounded up (683,566 since a reading answered with a held emission counts its work toward its
 * own limit alone). A change that does more of the reading in one piece fails here, whatever
 * the machine.
 */
const PIECE_UNITS_AT_MOST = 4_000_000;

describe("a bring-in's read at the byte cap", () => {
	it("answers an account of one too-large for an application resource one byte over, with no app name, and cancels the peer's stream at the bound", async () => {
		let stream: Promise<{ ended: boolean }> | undefined;
		await withSocketHttpPeer(
			HOSTNAME,
			(request: IncomingMessage, response: ServerResponse) => {
				if (request.url === PATHS.application) stream = overTheCap(response);
				else {
					response.writeHead(404);
					response.end();
				}
			},
			async () => {
				const { result } = await gather();
				expect(result).toEqual({
					kind: "account",
					account: {
						kind: "account",
						appName: null,
						findings: [
							{
								code: "too-large",
								standing: "not-yet",
								place: { kind: "app" },
								subject: null,
								detail: {},
							},
						],
						more: 0,
						counts: { notYet: 1, never: 0, fixInHq: 0 },
						mediaChecked: false,
					},
				});
				expect(await stream).toEqual({ ended: false });
			},
		);
	}, 60_000);

	it("answers an account of one too-large for a source one byte over, with no app name though the resource named it, and cancels the peer's stream at the bound", async () => {
		let stream: Promise<{ ended: boolean }> | undefined;
		const requested: string[] = [];
		await withSocketHttpPeer(
			HOSTNAME,
			(request: IncomingMessage, response: ServerResponse) => {
				requested.push(request.url ?? "");
				if (request.url === PATHS.application)
					send(response, {
						...retainedReadingRead("application"),
						body: JSON.stringify({
							...retainedBodyJson(retainedReadingRead("application")),
							id: APP,
						}),
					});
				else if (request.url === PATHS.source) stream = overTheCap(response);
				else {
					response.writeHead(404);
					response.end();
				}
			},
			async () => {
				const { result } = await gather();
				expect(result).toEqual({
					kind: "account",
					account: {
						kind: "account",
						appName: null,
						findings: [
							{
								code: "too-large",
								standing: "not-yet",
								place: { kind: "app" },
								subject: null,
								detail: {},
							},
						],
						more: 0,
						counts: { notYet: 1, never: 0, fixInHq: 0 },
						mediaChecked: false,
					},
				});
				expect(await stream).toEqual({ ended: false });
				/* No body past the bound is parsed: the counter is never asked. */
				expect(requested).toEqual([PATHS.application, PATHS.source]);
			},
		);
	}, 60_000);

	it("reads a source and resource just under the cap to a review within its work limit, no piece doing more than its share", {
		// A whole reading, acceptance and review at the cap: tens of seconds on a shared machine.
		timeout: 600_000,
	}, async () => {
		const built = nearTheCap();
		expect(built.menus).toBeGreaterThan(100);
		await withSocketHttpPeer(
			HOSTNAME,
			(request: IncomingMessage, response: ServerResponse) => {
				if (request.url === PATHS.application)
					send(response, built.application);
				else if (request.url === PATHS.source) send(response, built.source);
				else if (request.url === PATHS.version)
					send(response, retainedReadingRead("current-version"));
				else if (request.url === PATHS.tables) send(response, noTables());
				else {
					response.writeHead(404);
					response.end();
				}
			},
			async () => {
				const { result, facts } = await gather();
				if (result.kind !== "clean")
					throw new Error(
						result.kind === "account"
							? result.account.findings
									.map(
										(finding) => `${finding.code} ${finding.detail.name ?? ""}`,
									)
									.join(", ")
							: result.finding.code,
					);
				expect(result.gathered.review.creates.menus).toBe(built.menus);
				expect(facts.sourceBytes).toBeGreaterThan(
					HQ_BRING_IN_APP_MAX_BYTES * 0.9,
				);
				/* The contract is the work meter's, which no machine moves: the request's work
				 * within a quarter of one reading's limit of the source's size, and no piece
				 * doing more than `PIECE_UNITS_AT_MOST` between two turns of the event loop. */
				const characters = sourceCharacters(retainedBodyJson(built.source));
				const limit = readWorkLimit(characters);
				console.info(
					`The read at the cap: ${facts.workUnits} units over ${characters} characters (its limit ${limit}), the most in one piece ${facts.longestPieceUnits} units, part of ${facts.longestPieceUnitsAt}; ${Math.round(facts.checkMs)} ms of pieces, the longest ${Math.round(facts.longestPieceMs)} ms, part of ${facts.longestPieceAt}.`,
				);
				expect(facts.workUnits).toBeLessThanOrEqual(limit / 4);
				expect(
					facts.longestPieceUnits,
					`The piece that did the most, part of ${facts.longestPieceUnitsAt}, did ${facts.longestPieceUnits} units.`,
				).toBeLessThanOrEqual(PIECE_UNITS_AT_MOST);
				/* Wall time on a shared machine is no contract: one observation, failing only
				 * at four times the five seconds a piece is meant to stay under. */
				expect(
					facts.longestPieceMs,
					`The longest piece, part of ${facts.longestPieceAt}, took ${Math.round(facts.longestPieceMs)} ms.`,
				).toBeLessThan(20_000);
			},
		);
	});
});
