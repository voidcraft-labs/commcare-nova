/**
 * The peer a lane reading is served through, under native `fetch`.
 *
 * Contract: for the length of `withRetainedHq`, every request native `fetch`
 * makes is answered from CommCare HQ's retained answer for it, once, with the
 * status, headers and body HQ gave; a request with no retained answer, or a
 * second request of one already given, is refused and ends the run naming its
 * path; no socket is opened; and the dispatcher that stood before is put back
 * whether the run returned or threw. The lane's one target and one reading id
 * are the capture's target and an id production admits.
 *
 * Plausible failure: a peer that answers a request it holds nothing for (so a
 * reading the lane cannot reproduce passes), one that lets a request reach the
 * network, one that leaves its agent in place after a failure (so every later
 * request in the process is answered by it), or a lane target that drifts from
 * the capture's, so a reading asks for paths HQ was never asked at.
 */

import { Socket } from "node:net";
import { getGlobalDispatcher } from "undici";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	type RetainedHqAnswer as HelperAnswer,
	retainedBodyJson,
	retainedBodyText,
	retainedGroupRead,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { READING_ID_PATTERN } from "@/lib/deployment/reading/types";
import type { RetainedHqAnswer } from "@/proof/corpus/hqAuthored";
import { PROOF_DOMAIN, PROOF_SERVER } from "@/proof/corpus/publish";
import { type LaneReadInput, readForLane } from "../laneReading";
import {
	LANE_READING_ID,
	LANE_TARGET,
	RetainedAnswerMissing,
	withRetainedHq,
} from "../retainedPeer";

const ORIGIN = "https://www.commcarehq.org";

/** A retained answer as the lane's files hold it: the body as text. */
function asRetained(answer: HelperAnswer): RetainedHqAnswer {
	return {
		status: answer.status,
		headers: answer.headers,
		body: retainedBodyText(answer),
	};
}

const application = retainedReadingRead("application");
const APP_ID = retainedBodyJson(application).id as string;

const ANSWERS = {
	application: asRetained(application),
	source: asRetained(retainedGroupRead("navigation-base/app-source")),
	currentVersion: asRetained(retainedReadingRead("current-version")),
	projectData: {
		lookupTables: asRetained(retainedGroupRead("lookups/lookup-tables")),
		fixtureRows: {
			plain: asRetained(retainedGroupRead("lookups/fixture-rows-plain")),
		},
		media: [
			{
				path: "jr://file/commcare/image/menu.png",
				mediaType: "CommCareImage",
				multimediaId: "a1b2c3",
				status: 200,
				base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
			},
		],
	},
} as const;

const connects = vi.spyOn(Socket.prototype, "connect");

afterEach(() => {
	connects.mockClear();
});

afterAll(() => {
	connects.mockRestore();
});

describe("withRetainedHq", () => {
	it("answers each retained request once, as HQ gave it, and lists what was asked", async () => {
		const plainId = (
			retainedBodyJson(retainedGroupRead("lookups/lookup-tables")).objects as {
				id: string;
				tag: string;
			}[]
		).find((table) => table.tag === "plain")?.id;
		const { version, rows, file, asked } = await withRetainedHq(
			ANSWERS,
			async (peer) => {
				const versionRes = await fetch(
					`${ORIGIN}/a/${LANE_TARGET.domain}/apps/view/${APP_ID}/current_version/`,
				);
				const rowsRes = await fetch(
					`${ORIGIN}/a/${LANE_TARGET.domain}/api/fixture/v1/?fixture_type_id=${plainId}`,
				);
				const fileRes = await fetch(
					`${ORIGIN}/hq/multimedia/file/CommCareImage/a1b2c3/`,
				);
				return {
					version: {
						status: versionRes.status,
						type: versionRes.headers.get("content-type"),
						body: await versionRes.text(),
					},
					rows: await rowsRes.text(),
					file: Buffer.from(await fileRes.arrayBuffer()),
					asked: peer.asked(),
				};
			},
		);
		expect(version).toEqual({
			status: ANSWERS.currentVersion.status,
			type: ANSWERS.currentVersion.headers?.["Content-Type"],
			body: ANSWERS.currentVersion.body,
		});
		expect(rows).toBe(ANSWERS.projectData.fixtureRows.plain.body);
		expect(file).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		expect(asked).toEqual([
			"currentVersion",
			"fixtureRows:plain",
			"media:jr://file/commcare/image/menu.png",
		]);
		expect(connects).not.toHaveBeenCalled();
	});

	it("refuses a request it holds no answer for, names its path and opens no socket", async () => {
		const run = withRetainedHq(ANSWERS, async () => {
			// Nova's client catches a refused request and turns it into a failure of its own;
			// the peer ends the run whatever the client made of it.
			await fetch(`${ORIGIN}/a/${LANE_TARGET.domain}/api/location/v2/`).catch(
				() => undefined,
			);
			return "read";
		});
		await expect(run).rejects.toThrow(
			new RetainedAnswerMissing(`/a/${LANE_TARGET.domain}/api/location/v2/`),
		);
		expect(connects).not.toHaveBeenCalled();
	});

	it("keeps the source project's flag answers distinct", async () => {
		const base = "/api/user_domains/v1/?limit=100";
		const locations = `${base}&feature_flag=hierarchical_location_fixture`;
		const mobile = `${base}&feature_flag=mobile_ucr`;
		const answers = {
			...ANSWERS,
			projectSpaces: {
				all: { status: 200, body: "member" },
				flagged: { status: 200, body: "save on edit" },
			},
			sourceFactoryReads: {
				[locations]: { status: 200, body: "hierarchical" },
				"membership:hierarchical_location_fixture": {
					status: 200,
					body: "reader",
				},
			},
		};
		const bodies = await withRetainedHq(answers, async () => {
			const seen = [];
			for (const path of [
				base,
				`${base}&feature_flag=save-only-edited-form-fields`,
				base,
				locations,
			])
				seen.push(await (await fetch(ORIGIN + path)).text());
			return seen;
		});
		expect(bodies).toEqual([
			"member",
			"save on edit",
			"reader",
			"hierarchical",
		]);
		await expect(
			withRetainedHq(answers, async () => {
				await fetch(ORIGIN + mobile).catch(() => undefined);
			}),
		).rejects.toThrow(RetainedAnswerMissing);
	});

	it("refuses a second request of an answer it already gave", async () => {
		const path = `/a/${LANE_TARGET.domain}/api/application/v1/${APP_ID}/`;
		const run = withRetainedHq(ANSWERS, async () => {
			const first = await fetch(`${ORIGIN}${path}`);
			await first.text();
			await fetch(`${ORIGIN}${path}`).catch(() => undefined);
		});
		await expect(run).rejects.toThrow(new RetainedAnswerMissing(path));
	});

	it("gives a table's rows again, as an unchanged HQ answers a rich table's second observation", async () => {
		const plainId = (
			retainedBodyJson(retainedGroupRead("lookups/lookup-tables")).objects as {
				id: string;
				tag: string;
			}[]
		).find((table) => table.tag === "plain")?.id;
		const path = `/a/${LANE_TARGET.domain}/api/fixture/v1/?fixture_type_id=${plainId}`;
		const { bodies, asked } = await withRetainedHq(ANSWERS, async (peer) => {
			const seen = [];
			for (let read = 0; read < 3; read++)
				seen.push(await (await fetch(`${ORIGIN}${path}`)).text());
			return { bodies: seen, asked: peer.asked() };
		});
		const body = ANSWERS.projectData.fixtureRows.plain.body;
		expect(bodies).toEqual([body, body, body]);
		expect(asked).toEqual(["fixtureRows:plain"]);
	});

	it("gives a file past its kind's upload cap twice, as a reading streams it after its read in memory, and a file within it once", async () => {
		const large = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
		const answers = {
			...ANSWERS,
			projectData: {
				...ANSWERS.projectData,
				media: [
					...ANSWERS.projectData.media,
					{
						path: "jr://file/commcare/image/large.png",
						mediaType: "CommCareImage",
						multimediaId: "large",
						status: 200,
						base64: large.toString("base64"),
					},
				],
			},
		};
		const largePath = "/hq/multimedia/file/CommCareImage/large/";
		const sizes = await withRetainedHq(answers, async () => {
			const seen = [];
			for (let read = 0; read < 2; read++)
				seen.push(
					(await (await fetch(`${ORIGIN}${largePath}`)).arrayBuffer())
						.byteLength,
				);
			return seen;
		});
		expect(sizes).toEqual([large.byteLength, large.byteLength]);
		await expect(
			withRetainedHq(answers, async () => {
				for (let read = 0; read < 3; read++)
					await (await fetch(`${ORIGIN}${largePath}`))
						.arrayBuffer()
						.catch(() => undefined);
			}),
		).rejects.toThrow(new RetainedAnswerMissing(largePath));
		const smallPath = "/hq/multimedia/file/CommCareImage/a1b2c3/";
		await expect(
			withRetainedHq(answers, async () => {
				await (await fetch(`${ORIGIN}${smallPath}`)).arrayBuffer();
				await fetch(`${ORIGIN}${smallPath}`).catch(() => undefined);
			}),
		).rejects.toThrow(new RetainedAnswerMissing(smallPath));
	});

	it("refuses a request to any other host", async () => {
		const run = withRetainedHq(ANSWERS, async () => {
			await fetch("https://india.commcarehq.org/api/user_domains/v1/").catch(
				() => undefined,
			);
		});
		await expect(run).rejects.toThrow(
			new RetainedAnswerMissing("/api/user_domains/v1/"),
		);
		expect(connects).not.toHaveBeenCalled();
	});

	it("puts the dispatcher that stood before back, after a run that threw as after one that returned", async () => {
		const before = getGlobalDispatcher();
		await expect(
			withRetainedHq(ANSWERS, async () => {
				throw new Error("the run failed");
			}),
		).rejects.toThrow("the run failed");
		expect(getGlobalDispatcher()).toBe(before);
		await withRetainedHq(ANSWERS, async () => undefined);
		expect(getGlobalDispatcher()).toBe(before);
	});
});

describe("the lane's target and reading id", () => {
	it("are the capture's target and an id production admits", () => {
		expect(LANE_TARGET).toEqual({ server: PROOF_SERVER, domain: PROOF_DOMAIN });
		expect(READING_ID_PATTERN.test(LANE_READING_ID)).toBe(true);
	});
});

describe("readForLane", () => {
	const input: LaneReadInput = {
		appId: "hq-plain",
		source: ANSWERS.source,
		application: ANSWERS.application,
		currentVersion: ANSWERS.currentVersion,
		identity: "mint",
		claims: "counts",
	};

	it("refuses a first reading with no project data before it asks HQ anything", async () => {
		await expect(readForLane(input)).rejects.toThrow(
			"A first reading of an app CommCare HQ holds needs HQ's project data answers",
		);
		expect(connects).not.toHaveBeenCalled();
	});

	it("refuses a read back with no document before it asks HQ anything", async () => {
		await expect(
			readForLane({
				...input,
				identity: "match",
				projectData: ANSWERS.projectData,
			}),
		).rejects.toThrow(
			"A read back gives the corpus document's own identities back, so it needs that document",
		);
		expect(connects).not.toHaveBeenCalled();
	});
});
