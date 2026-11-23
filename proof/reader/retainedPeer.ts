/**
 * CommCare HQ's retained answers, served to Nova's own client for the length
 * of one lane reading.
 *
 * The peer is an undici `MockAgent` put in place as the global dispatcher, so
 * native `fetch` (the dispatch path Nova's client uses) reaches it and
 * nothing else: the agent refuses every connection, and each request Nova's
 * client makes is answered from the retained answer for it, status, headers
 * and body as HQ gave them, once. A request with no retained answer, or a
 * second request of one already given, is refused by the agent; the reading
 * then ends naming that request's path (`RetainedAnswerMissing`). No socket
 * is opened.
 */

import {
	type Dispatcher,
	getGlobalDispatcher,
	MockAgent,
	setGlobalDispatcher,
} from "undici";
import type { CommCareCredentials } from "@/lib/commcare/hq/http";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import type { RetainedHqAnswer } from "@/proof/corpus/hqAuthored";
import type { LaneReadInput } from "./laneReading";

/** The one target every request of a lane reading is built with: `proof/corpus/publish.ts`'s
 *  `PROOF_SERVER` and `PROOF_DOMAIN`, written out here so the bundle carries no capture code.
 *  `retainedPeer.test.ts` holds the two equal to those constants. */
export const LANE_TARGET = {
	server: "production",
	domain: "nova-proof",
} as const;

/** The reading id of every lane reading: a UUIDv7 written out, which `READING_ID_PATTERN`
 *  admits. Its time bits order nothing: every id a reading derives from it is a digest. */
export const LANE_READING_ID = "01900000-0000-7000-8000-000000000000";

export interface RetainedHqPeer {
	/** A fixed credential. The agent checks no key: HQ checked it when the answer was made. */
	readonly creds: CommCareCredentials;
	/** The names of the retained answers consumed so far, in the order they were asked for. */
	asked(): readonly string[];
}

/** A request the peer holds no answer for. Its message is the request's path alone; the
 *  reading that met it names itself around it. */
export class RetainedAnswerMissing extends Error {
	constructor(readonly path: string) {
		super(path);
		this.name = "RetainedAnswerMissing";
	}
}

const CREDS: CommCareCredentials = {
	username: "lane@nova-proof.commcarehq.org",
	apiKey: "lane-reading",
	server: LANE_TARGET.server,
};

const ORIGIN = COMMCARE_SERVERS[LANE_TARGET.server].baseUrl;

type Answers = Pick<
	LaneReadInput,
	| "source"
	| "application"
	| "currentVersion"
	| "projectSpaces"
	| "projectData"
	| "sourceFactoryReads"
>;

interface Served {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string | Buffer;
}

function served(answer: RetainedHqAnswer): Served {
	return {
		status: answer.status,
		headers: answer.headers ?? {},
		body: answer.body ?? "",
	};
}

/** The JSON body of a retained answer, or undefined where it holds none. */
function bodyJson(answer: RetainedHqAnswer | undefined): unknown {
	if (answer?.body === undefined) return undefined;
	try {
		return JSON.parse(answer.body);
	} catch {
		return undefined;
	}
}

/** The app id the retained application resource names. */
function applicationId(answers: Answers): string | undefined {
	const body = bodyJson(answers.application);
	if (typeof body !== "object" || body === null) return undefined;
	const id = (body as { readonly id?: unknown }).id;
	return typeof id === "string" ? id : undefined;
}

/** Each table id of the retained lookup table list, by the tag it holds. */
function tagsByTableId(answers: Answers): ReadonlyMap<string, string> {
	const tags = new Map<string, string>();
	const body = bodyJson(answers.projectData?.lookupTables);
	const objects =
		typeof body === "object" && body !== null
			? (body as { readonly objects?: unknown }).objects
			: undefined;
	if (!Array.isArray(objects)) return tags;
	for (const object of objects) {
		if (typeof object !== "object" || object === null) continue;
		const { id, tag } = object as { readonly id?: unknown; tag?: unknown };
		if (typeof id === "string" && typeof tag === "string") tags.set(id, tag);
	}
	return tags;
}

/**
 * The retained answer for a request to `path` (with its query), by its name in `asked`, or
 * undefined where the lane holds none. The paths are the ones Nova's client builds for the
 * lane's target: `lib/commcare/hq/application.ts`, `appSource.ts`, `client.ts`'s version and
 * project space reads, `lookupTables.ts`, `locations.ts` and `media.ts`.
 */
function answerFor(
	answers: Answers,
	path: string,
	asked: readonly string[],
): { readonly name: string; readonly answer: Served } | undefined {
	const url = new URL(path, ORIGIN);
	const at = url.pathname;
	const space = `/a/${LANE_TARGET.domain}`;
	const appId = applicationId(answers);
	const extra = answers.sourceFactoryReads;
	const held = extra && Object.hasOwn(extra, path) ? extra[path] : undefined;
	if (held) return { name: `factory:${path}`, answer: served(held) };
	if (
		asked.includes("source") &&
		at === `${space}/apps/source/${appId}/` &&
		extra?.["source-check"]
	)
		return {
			name: "factory:source-check",
			answer: served(extra["source-check"]),
		};
	if (appId !== undefined) {
		if (at === `${space}/api/application/v1/${appId}/`)
			return { name: "application", answer: served(answers.application) };
		if (at === `${space}/apps/source/${appId}/`)
			return { name: "source", answer: served(answers.source) };
		if (at === `${space}/apps/view/${appId}/current_version/`)
			return { name: "currentVersion", answer: served(answers.currentVersion) };
	}
	if (at === "/api/user_domains/v1/" && answers.projectSpaces !== undefined) {
		const flag = url.searchParams.get("feature_flag");
		if (flag !== null && flag !== "save-only-edited-form-fields") return;
		if (flag === null && asked.includes("projectSpaces:all") && extra) {
			const repeat = Object.keys(extra).find(
				(key) =>
					key.startsWith("membership:") && !asked.includes(`factory:${key}`),
			);
			if (repeat)
				return { name: `factory:${repeat}`, answer: served(extra[repeat]) };
		}
		return flag !== null
			? {
					name: "projectSpaces:flagged",
					answer: served(answers.projectSpaces.flagged),
				}
			: {
					name: "projectSpaces:all",
					answer: served(answers.projectSpaces.all),
				};
	}
	const data = answers.projectData;
	if (data === undefined) return undefined;
	if (at === `${space}/api/lookup_table/v1/`)
		return { name: "lookupTables", answer: served(data.lookupTables) };
	if (at === `${space}/api/fixture/v1/`) {
		const tableId = url.searchParams.get("fixture_type_id");
		const tag =
			tableId === null ? undefined : tagsByTableId(answers).get(tableId);
		const rows =
			tag === undefined || !Object.hasOwn(data.fixtureRows, tag)
				? undefined
				: data.fixtureRows[tag];
		return rows === undefined
			? undefined
			: { name: `fixtureRows:${tag}`, answer: served(rows) };
	}
	if (
		at === `${space}/api/location_type/v1/` &&
		data.locationTypes !== undefined
	)
		return { name: "locationTypes", answer: served(data.locationTypes) };
	if (at === `${space}/api/location/v2/` && data.locations !== undefined)
		return { name: "locations", answer: served(data.locations) };
	const file = /^\/hq\/multimedia\/file\/([^/]+)\/([^/]+)\/$/.exec(at);
	if (file !== null) {
		const [, mediaType, multimediaId] = file;
		const read = data.media.find(
			(one) => one.mediaType === mediaType && one.multimediaId === multimediaId,
		);
		if (read === undefined) return undefined;
		return {
			name: `media:${read.path}`,
			answer: {
				status: read.status,
				headers: {},
				body:
					read.base64 === undefined ? "" : Buffer.from(read.base64, "base64"),
			},
		};
	}
	return undefined;
}

/** Answers native `fetch` from `answers` for the length of `run`, and nothing else. */
export async function withRetainedHq<T>(
	answers: Answers,
	run: (peer: RetainedHqPeer) => Promise<T>,
): Promise<T> {
	const asked: string[] = [];
	let missing: string | undefined;
	const previous: Dispatcher = getGlobalDispatcher();
	const agent = new MockAgent();
	agent.disableNetConnect();
	const refuse = (path: string): never => {
		missing ??= path;
		throw new RetainedAnswerMissing(path);
	};
	agent
		.get(ORIGIN)
		.intercept({ path: () => true, method: () => true })
		.reply((request) => {
			const found =
				request.method === "GET"
					? answerFor(answers, request.path, asked)
					: undefined;
			const path = new URL(request.path, ORIGIN).pathname;
			if (found === undefined || asked.includes(found.name))
				return refuse(path);
			asked.push(found.name);
			return {
				statusCode: found.answer.status,
				data: found.answer.body,
				responseOptions: { headers: { ...found.answer.headers } },
			};
		})
		.persist();
	agent
		.get((origin: string) => origin !== ORIGIN)
		.intercept({ path: () => true, method: () => true })
		.reply((request) => refuse(new URL(request.path, ORIGIN).pathname))
		.persist();
	setGlobalDispatcher(agent);
	try {
		const result = await run({ creds: CREDS, asked: () => [...asked] });
		if (missing !== undefined) throw new RetainedAnswerMissing(missing);
		return result;
	} catch (error) {
		if (missing !== undefined && !(error instanceof RetainedAnswerMissing))
			throw new RetainedAnswerMissing(missing);
		throw error;
	} finally {
		setGlobalDispatcher(previous);
		await agent.close();
	}
}
