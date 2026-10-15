/**
 * The cutover's reads with the real client code against a peer under the
 * test's control: the transport outcomes HQ's own views do not produce (no
 * answer, a 5xx, a redirect, a 400, a body that is no JSON, an edge's
 * refusal page), how often each is sent again and how long it waits, and
 * the pace of one run's reads, on a clock the test owns. What HQ itself
 * answers is `classes.test.ts`, over HQ's retained answers.
 */

import type { MockAgent } from "undici";
import { describe, expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import type { CommCareCredentials } from "@/lib/commcare/hq/http";
import {
	classifyDeployment,
	classifyHqFailure,
	type DeploymentReads,
	HqReadPacer,
	LIMITED_READ_SPACING_MS,
	RATE_LIMITED_WAIT_MS,
	readDeployment,
	readHqApplicationFormIds,
	SPACES_ABREAST,
} from "../hqRead";
import type { DecryptClock } from "../kmsDecrypt";
import { novaForm, novaMenu } from "./fixtures/matchingInputs";

const HOST = "https://www.commcarehq.org";
const DOMAIN = "field-ops";
const APP = "hq-app-1";
const SOURCE = `/a/${DOMAIN}/apps/source/${APP}/`;
const FORM_IDS = `/a/${DOMAIN}/api/v0.4/application/${APP}/`;

/** A clock whose sleeps pass at once and are recorded. */
function ownedClock(start = Date.parse("2026-10-15T10:00:00.000Z")) {
	let now = start;
	const sleeps: number[] = [];
	const clock: DecryptClock = {
		now: () => now,
		sleep: async (milliseconds) => {
			sleeps.push(milliseconds);
			now += milliseconds;
		},
	};
	return { clock, sleeps, advance: (ms: number) => (now += ms) };
}

const credentialsOf = (userId: string): CommCareCredentials => ({
	username: `${userId}@example.org`,
	apiKey: `key-${userId}`,
	server: "production",
});

const SOURCE_BODY = {
	doc_type: "Application",
	build_spec: { version: "2.60.0" },
	profile: { properties: { "cc-show-saved": "yes" } },
	langs: ["en"],
	_attachments: {
		"read-1.xml":
			'<h:html xmlns:h="http://www.w3.org/1999/xhtml"><h:head><model><instance><data><name/></data></instance></model></h:head></h:html>',
	},
	modules: [
		{
			unique_id: "m1",
			case_type: "patient",
			name: { en: "Patients" },
			forms: [
				{ unique_id: "read-1", xmlns: "x-register", name: { en: "Register" } },
			],
		},
	],
};
const FORM_IDS_BODY = {
	modules: [
		{
			unique_id: "m1",
			forms: [{ unique_id: "stored-1", xmlns: "x-register" }],
		},
	],
};

function intercept(peer: MockAgent, path: string, userId = "member-a") {
	return peer.get(HOST).intercept({
		path,
		method: "GET",
		headers: { authorization: `ApiKey ${userId}@example.org:key-${userId}` },
	});
}

/** Read the deployment the peer serves. */
async function read(
	options: { credentials?: string[]; clock?: DecryptClock } = {},
): Promise<DeploymentReads> {
	const clock = options.clock ?? ownedClock().clock;
	return readDeployment(
		{ server: "production", domain: DOMAIN, remoteAppId: APP },
		{
			credentials: options.credentials ?? ["member-a"],
			credentialSource: async (userId) => credentialsOf(userId),
			pacer: new HqReadPacer(clock),
			clock,
		},
	);
}

const today = [
	novaMenu("patients", "Patients", "patient", [
		novaForm("register", "Register", ["/data/name"]),
	]),
];

describe("one request, classed", () => {
	it("classes a status a read synthesized by its cause", () => {
		expect(
			classifyHqFailure({ success: false, status: 503, cause: "network" }),
		).toEqual({ kind: "transient", cause: "no-answer" });
		expect(
			classifyHqFailure({ success: false, status: 503, cause: "timeout" }),
		).toEqual({ kind: "transient", cause: "timeout" });
		expect(
			classifyHqFailure({ success: false, status: 502, cause: "malformed" }),
		).toEqual({ kind: "unreadable", cause: "malformed" });
	});

	it("never takes HQ's own empty-bodied refusal for an edge's", async () => {
		await withHttpPeer(async (peer) => {
			intercept(peer, FORM_IDS).reply(401, "", {
				headers: { "content-type": "text/html" },
			});
			expect(
				await readHqApplicationFormIds(credentialsOf("member-a"), DOMAIN, APP),
			).toEqual({ kind: "refused", status: 401 });
		});
	});

	it("classes an edge's refusal page as transient, a redirect and a 400 as unreadable", async () => {
		await withHttpPeer(async (peer) => {
			intercept(peer, FORM_IDS).reply(
				502,
				"<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>",
			);
			expect(
				await readHqApplicationFormIds(credentialsOf("member-a"), DOMAIN, APP),
			).toEqual({ kind: "transient", cause: "edge" });
			intercept(peer, FORM_IDS).reply(302, "", {
				headers: { location: "/accounts/login/" },
			});
			expect(
				await readHqApplicationFormIds(credentialsOf("member-a"), DOMAIN, APP),
			).toEqual({ kind: "unreadable", cause: "redirect" });
			intercept(peer, FORM_IDS).reply(400, "{}");
			expect(
				await readHqApplicationFormIds(credentialsOf("member-a"), DOMAIN, APP),
			).toEqual({ kind: "unreadable", cause: "400" });
			intercept(peer, FORM_IDS).reply(200, "not json");
			expect(
				await readHqApplicationFormIds(credentialsOf("member-a"), DOMAIN, APP),
			).toEqual({ kind: "unreadable", cause: "malformed" });
			intercept(peer, FORM_IDS).reply(200, { modules: [{ unique_id: 7 }] });
			expect(
				await readHqApplicationFormIds(credentialsOf("member-a"), DOMAIN, APP),
			).toEqual({ kind: "unreadable", cause: "malformed" });
		});
	});
});

describe("one deployment's reads, through their attempts", () => {
	it("sends a read that got no answer three times, waiting 2 s and then 8 s", async () => {
		const { clock, sleeps } = ownedClock();
		await withHttpPeer(async (peer) => {
			intercept(peer, SOURCE)
				.replyWithError(new Error("connection reset"))
				.times(3);
			const reads = await read({ clock });
			expect(reads.source).toEqual({ kind: "transient", cause: "no-answer" });
			expect(reads.formIds).toBeNull();
			expect(sleeps).toEqual([2_000, 8_000]);
		});
	});

	it("takes a 5xx followed by an answer within its attempts", async () => {
		const { clock, sleeps } = ownedClock();
		await withHttpPeer(async (peer) => {
			intercept(peer, SOURCE).reply(500, "server error");
			intercept(peer, SOURCE).reply(200, SOURCE_BODY);
			intercept(peer, FORM_IDS).reply(200, FORM_IDS_BODY);
			const reads = await read({ clock });
			expect(reads.source?.kind).toBe("ok");
			expect(reads.formIds).toEqual({
				kind: "ok",
				value: [
					{
						kind: "module",
						uniqueId: "m1",
						forms: [{ uniqueId: "stored-1", xmlns: "x-register" }],
					},
				],
			});
			expect(sleeps).toEqual([2_000]);
		});
	});

	it("waits as long as a 5xx's Retry-After asks where that is longer than its own wait", async () => {
		const { clock, sleeps } = ownedClock();
		await withHttpPeer(async (peer) => {
			intercept(peer, SOURCE).reply(503, "unavailable", {
				headers: { "retry-after": "30" },
			});
			intercept(peer, SOURCE).reply(200, SOURCE_BODY);
			intercept(peer, FORM_IDS).reply(200, FORM_IDS_BODY);
			const reads = await read({ clock });
			expect(reads.source?.kind).toBe("ok");
			expect(sleeps).toEqual([30_000]);
		});
	});

	it("sends nothing sooner than a Retry-After over a minute asks, ending the read transient", async () => {
		const { clock, sleeps } = ownedClock();
		await withHttpPeer(async (peer) => {
			intercept(peer, SOURCE).reply(503, "unavailable", {
				headers: { "retry-after": "120" },
			});
			const reads = await read({ clock });
			expect(reads.source).toMatchObject({ kind: "transient", cause: "5xx" });
			expect(peer.getCallHistory()?.calls()).toHaveLength(1);
			expect(sleeps).toEqual([]);
		});
	});

	it("reads a Retry-After that names a date as no wait of its own", async () => {
		const { clock, sleeps } = ownedClock();
		await withHttpPeer(async (peer) => {
			intercept(peer, SOURCE).reply(503, "unavailable", {
				headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
			});
			intercept(peer, SOURCE).reply(200, SOURCE_BODY);
			intercept(peer, FORM_IDS).reply(200, FORM_IDS_BODY);
			const reads = await read({ clock });
			expect(reads.source?.kind).toBe("ok");
			expect(sleeps).toEqual([2_000]);
		});
	});

	it("waits as long as an edge refusal's Retry-After asks", async () => {
		const { clock, sleeps } = ownedClock();
		await withHttpPeer(async (peer) => {
			intercept(peer, SOURCE).reply(
				502,
				"<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>",
				{ headers: { "retry-after": "5" } },
			);
			intercept(peer, SOURCE).reply(200, SOURCE_BODY);
			intercept(peer, FORM_IDS).reply(200, FORM_IDS_BODY);
			const reads = await read({ clock });
			expect(reads.source?.kind).toBe("ok");
			expect(sleeps).toEqual([5_000]);
		});
	});

	it("waits one minute window after a 429 and classes a third one transient", async () => {
		const { clock, sleeps } = ownedClock();
		await withHttpPeer(async (peer) => {
			intercept(peer, SOURCE).reply(200, SOURCE_BODY);
			intercept(peer, FORM_IDS).reply(429, "").times(3);
			const reads = await read({ clock });
			expect(reads.formIds).toEqual({ kind: "transient", cause: "429" });
			expect(sleeps.filter((ms) => ms === RATE_LIMITED_WAIT_MS)).toHaveLength(
				2,
			);
		});
	});

	it("moves a refused read to the next member and leaves the other read where it is", async () => {
		await withHttpPeer(async (peer) => {
			intercept(peer, SOURCE, "member-a").reply(403, "");
			intercept(peer, SOURCE, "member-b").reply(200, SOURCE_BODY);
			intercept(peer, FORM_IDS, "member-a").reply(200, FORM_IDS_BODY);
			const reads = await read({ credentials: ["member-a", "member-b"] });
			expect(reads.source?.kind).toBe("ok");
			expect(reads.formIds?.kind).toBe("ok");
			expect(reads.keyUses.map((use) => use.userId)).toEqual([
				"member-a",
				"member-b",
			]);
		});
	});

	it("sends nothing for a deployment no member's key qualifies for", async () => {
		await withHttpPeer(async (peer) => {
			const reads = await read({ credentials: [] });
			expect(reads).toEqual({ source: null, formIds: null, keyUses: [] });
			expect(peer.getCallHistory()?.calls() ?? []).toEqual([]);
		});
	});
});

describe("one deployment's class from its reads", () => {
	const published = { kind: "none", reason: "before-horizon" } as const;
	const sourceOk = async (peer: MockAgent, formIds: () => void) => {
		intercept(peer, SOURCE).reply(200, SOURCE_BODY);
		formIds();
		return read();
	};

	it("is read in full where both reads answered and aligned", async () => {
		await withHttpPeer(async (peer) => {
			const reads = await sourceOk(peer, () =>
				intercept(peer, FORM_IDS).reply(200, FORM_IDS_BODY),
			);
			const classed = classifyDeployment({
				reads,
				today,
				published,
				transientAsUnreadable: false,
			});
			expect(classed.outcome).toBe("read-in-full");
			expect(classed.pairing).toEqual({
				path: "evidence",
				reason: "before-horizon",
			});
			expect(classed.buildSpecVersion).toBe("2.60.0");
			expect(classed.profileProperties).toEqual({ "cc-show-saved": "yes" });
			expect(
				classed.identities.map((row) => [row.entityKind, row.remoteUniqueId]),
			).toEqual([
				["module", "m1"],
				["form", "stored-1"],
			]);
		});
	});

	it("has no form ids where the form id read is unreadable, and keeps menu ids and xmlns", async () => {
		await withHttpPeer(async (peer) => {
			const reads = await sourceOk(peer, () =>
				intercept(peer, FORM_IDS).reply(302, ""),
			);
			const classed = classifyDeployment({
				reads,
				today,
				published,
				transientAsUnreadable: false,
			});
			expect(classed.outcome).toBe("no-form-ids");
			expect(classed.identities).toEqual([
				expect.objectContaining({ entityKind: "module", remoteUniqueId: "m1" }),
				expect.objectContaining({
					entityKind: "form",
					remoteUniqueId: null,
					remoteXmlns: "x-register",
				}),
			]);
			expect(classed.formIdsUnknown).toHaveLength(1);
		});
	});

	it("stops on a transient read, and under --transient-as-unreadable classes it", async () => {
		await withHttpPeer(async (peer) => {
			const reads = await sourceOk(peer, () =>
				intercept(peer, FORM_IDS).replyWithError(new Error("reset")).times(3),
			);
			expect(
				classifyDeployment({
					reads,
					today,
					published,
					transientAsUnreadable: false,
				}).outcome,
			).toBe("transient");
			expect(
				classifyDeployment({
					reads,
					today,
					published,
					transientAsUnreadable: true,
				}).outcome,
			).toBe("no-form-ids");
		});
		await withHttpPeer(async (peer) => {
			intercept(peer, SOURCE).reply(503, "").times(3);
			const reads = await read();
			expect(
				classifyDeployment({
					reads,
					today,
					published,
					transientAsUnreadable: false,
				}).outcome,
			).toBe("transient");
			expect(
				classifyDeployment({
					reads,
					today,
					published,
					transientAsUnreadable: true,
				}).outcome,
			).toBe("unreadable");
		});
	});
});

describe("the pace", () => {
	it("starts the limited reads to one space at least seven seconds apart, never two at once, and spaces no source read", async () => {
		const { clock } = ownedClock();
		const pacer = new HqReadPacer(clock);
		const starts: { limited: boolean; at: number }[] = [];
		let inFlight = 0;
		let most = 0;
		const send = (limited: boolean) =>
			pacer.send("production", DOMAIN, limited, async () => {
				inFlight += 1;
				most = Math.max(most, inFlight);
				starts.push({ limited, at: clock.now() });
				await Promise.resolve();
				inFlight -= 1;
			});
		await Promise.all([
			send(true),
			send(false),
			send(true),
			send(false),
			send(true),
		]);
		expect(most).toBe(1);
		const limited = starts
			.filter((start) => start.limited)
			.map((start) => start.at);
		for (let index = 1; index < limited.length; index++) {
			expect(
				(limited[index] ?? 0) - (limited[index - 1] ?? 0),
			).toBeGreaterThanOrEqual(LIMITED_READ_SPACING_MS);
		}
		const sources = starts.filter((start) => !start.limited);
		expect(sources[0]?.at).toBe(limited[0]);
		// Replayed against HQ's floor (1 a second, 10 a minute, for a space with
		// no mobile worker and no subscription), no second and no minute holds
		// more limited reads than it allows.
		for (const at of limited) {
			expect(
				limited.filter((other) => other >= at && other < at + 1_000),
			).toHaveLength(1);
			expect(
				limited.filter((other) => other >= at && other < at + 60_000).length,
			).toBeLessThanOrEqual(10);
		}
		expect(pacer.spaceReads()).toEqual([
			{
				server: "production",
				domain: DOMAIN,
				limitedReads: 3,
				lastLimitedReadAt: new Date(limited.at(-1) ?? 0).toISOString(),
			},
		]);
	});

	it("runs at most four project spaces of one server abreast", async () => {
		const pacer = new HqReadPacer(ownedClock().clock);
		const releases: (() => void)[] = [];
		let inFlight = 0;
		let most = 0;
		const sends = ["a", "b", "c", "d", "e", "f"].map((domain) =>
			pacer.send("production", domain, false, async () => {
				inFlight += 1;
				most = Math.max(most, inFlight);
				await new Promise<void>((resolve) => releases.push(resolve));
				inFlight -= 1;
			}),
		);
		let settled = 0;
		const all = Promise.all(
			sends.map((send) => send.then(() => (settled += 1))),
		);
		while (settled < sends.length) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			releases.shift()?.();
		}
		await all;
		expect(most).toBe(SPACES_ABREAST);
	});
});
