/**
 * The app list, the envelope `testDomainAccess` reads of it, and the API
 * access check, over CommCare HQ's own answers (`proof/hq-reads/reading/`).
 *
 * A picker row with no id, one odd app failing the save of a key for every
 * project space, an odd slug stopping discovery, and the plan refusal read as
 * a bad key are what these cases would catch.
 */

import type { MockAgent } from "undici";
import { describe, expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedHqAnswer,
	type RetainedReadingRead,
	replyRetained,
	retainedBodyJson,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { testDomainAccess } from "../client";
import { listHqApps, probeHqApiAccess } from "../hq/apps";

const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const HOST = "https://india.commcarehq.org";
const LIST = "/a/clinic/apps/api/list_apps/";
const PROBE = "/a/clinic/api/lookup_table/v1/?limit=1";
const MALFORMED = { success: false, status: 502, cause: "malformed" };
const EDGE_403 =
	"<html><head><title>403 Forbidden</title></head><body><center><h1>403 Forbidden</h1></center></body></html>";

function serve(peer: MockAgent, path: string, answer: RetainedHqAnswer) {
	replyRetained(
		peer.get(HOST).intercept({
			path,
			method: "GET",
			headers: { authorization: "ApiKey account:key" },
		}),
		answer,
	);
}

/** The retained `list-apps` answer with its body changed. */
function listWith(
	change: (body: Record<string, unknown>) => void,
): RetainedHqAnswer {
	const answer = retainedReadingRead("list-apps");
	const body = structuredClone(retainedBodyJson(answer));
	change(body);
	return { ...answer, body: JSON.stringify(body) };
}

function rows(body: Record<string, unknown>): Record<string, unknown>[] {
	return body.applications as Record<string, unknown>[];
}

function paths(peer: MockAgent): string[] {
	return (
		peer
			.getCallHistory()
			?.calls()
			.map((call) => {
				const url = new URL(call.fullUrl);
				return url.pathname + url.search;
			}) ?? []
	);
}

describe("listHqApps", () => {
	it("reads every working app HQ lists, in its order, with its id, name and save counter", async () => {
		await withHttpPeer(async (peer) => {
			serve(peer, LIST, retainedReadingRead("list-apps"));
			const listed = await listHqApps(CREDS, "clinic");
			const sent = rows(retainedBodyJson(retainedReadingRead("list-apps")));
			/* The live app, the linked app and the remote app; no build and no deleted app. */
			expect(sent).toHaveLength(3);
			expect(listed).toEqual(
				sent.map((row) => ({
					appId: row.app_id,
					name: row.name,
					version: row.version,
				})),
			);
		});
	});

	it.each([
		[
			"a row without app_id",
			(body: Record<string, unknown>) => {
				delete rows(body)[1].app_id;
			},
		],
		[
			"one app_id twice",
			(body: Record<string, unknown>) => {
				rows(body)[1].app_id = rows(body)[0].app_id;
			},
		],
		[
			"an app_id outside an id's characters",
			(body: Record<string, unknown>) => {
				rows(body)[0].app_id = "../other";
			},
		],
		[
			"a name that is no string",
			(body: Record<string, unknown>) => {
				rows(body)[0].name = null;
			},
		],
		[
			"a negative version",
			(body: Record<string, unknown>) => {
				rows(body)[2].version = -1;
			},
		],
		[
			"a status other than success",
			(body: Record<string, unknown>) => {
				body.status = "error";
			},
		],
		[
			"no applications list",
			(body: Record<string, unknown>) => {
				delete body.applications;
			},
		],
	])("refuses the list with %s as malformed", async (_, change) => {
		await withHttpPeer(async (peer) => {
			serve(peer, LIST, listWith(change));
			expect(await listHqApps(CREDS, "clinic")).toEqual(MALFORMED);
		});
	});

	it("asks nothing for a slug Nova cannot put in a URL", async () => {
		await withHttpPeer(async (peer) => {
			expect(await listHqApps(CREDS, "clinic/space")).toEqual({
				success: false,
				status: 400,
			});
			expect(paths(peer)).toEqual([]);
		});
	});
});

describe("testDomainAccess", () => {
	it("reaches a project space whose envelope HQ answered, even where a row is one listHqApps refuses", async () => {
		await withHttpPeer(async (peer) => {
			const odd = listWith((body) => {
				rows(body)[0].version = "2";
			});
			serve(peer, LIST, odd);
			serve(peer, LIST, odd);
			expect(await listHqApps(CREDS, "clinic")).toEqual(MALFORMED);
			expect(await testDomainAccess(CREDS, "clinic")).toBe(true);
		});
	});

	it("does not reach a project space HQ itself refused with a 401 or a 403", async () => {
		await withHttpPeer(async (peer) => {
			for (const status of [401, 403]) {
				serve(peer, LIST, {
					status,
					headers: { "Content-Type": "text/html; charset=utf-8" },
				});
				expect(await testDomainAccess(CREDS, "clinic")).toBe(false);
			}
		});
	});

	it("answers the error for an edge's refusal, an outage and a wrong envelope", async () => {
		await withHttpPeer(async (peer) => {
			serve(peer, LIST, {
				status: 403,
				headers: { "Content-Type": "text/html" },
				body: EDGE_403,
			});
			expect(await testDomainAccess(CREDS, "clinic")).toEqual({
				success: false,
				status: 403,
				edgeRefusal: true,
			});
			serve(peer, LIST, { status: 503, headers: {}, body: "Unavailable" });
			expect(await testDomainAccess(CREDS, "clinic")).toEqual({
				success: false,
				status: 503,
				edgeRefusal: false,
			});
			serve(
				peer,
				LIST,
				listWith((body) => {
					delete body.applications;
				}),
			);
			expect(await testDomainAccess(CREDS, "clinic")).toEqual(MALFORMED);
		});
	});

	it("answers false with no request for a slug Nova cannot put in a URL", async () => {
		await withHttpPeer(async (peer) => {
			for (const domain of ["..", "clinic/space", "clinic?x=1"])
				expect(await testDomainAccess(CREDS, domain)).toBe(false);
			expect(paths(peer)).toEqual([]);
		});
	});
});

describe("probeHqApiAccess", () => {
	it.each([
		["api-access", { kind: "available" }],
		["api-access-no-plan", { kind: "plan-lacks-api-access" }],
		["api-access-no-permission", { kind: "account-lacks-access-apis" }],
	] as const satisfies readonly [RetainedReadingRead, unknown][])(
		"reads %s as its named answer, asking the lookup table list for one row",
		async (name, expected) => {
			await withHttpPeer(async (peer) => {
				serve(peer, PROBE, retainedReadingRead(name));
				expect(await probeHqApiAccess(CREDS, "clinic")).toEqual(expected);
				expect(paths(peer)).toEqual([PROBE]);
			});
		},
	);

	it("reads an edge's 403 and an answer that is no list as failures, never as the account or the plan", async () => {
		await withHttpPeer(async (peer) => {
			serve(peer, PROBE, {
				status: 403,
				headers: { "Content-Type": "text/html" },
				body: EDGE_403,
			});
			expect(await probeHqApiAccess(CREDS, "clinic")).toEqual({
				kind: "failed",
				failure: {
					kind: "gateway-refused",
					request: "api-access",
					status: 403,
				},
			});
			serve(peer, PROBE, {
				status: 200,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ objects: [] }),
			});
			expect(await probeHqApiAccess(CREDS, "clinic")).toEqual({
				kind: "failed",
				failure: {
					kind: "answer-unreadable",
					request: "api-access",
					status: 502,
				},
			});
		});
	});
});
