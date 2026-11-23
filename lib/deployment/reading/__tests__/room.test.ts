/**
 * Room for a bring-in: each request runs under a lease of the process's
 * memory meter, charged by what it reads and keeps, over `gatherFromHq` with
 * a Project side that holds nothing and CommCare HQ answering on a loopback
 * socket.
 *
 * Ordinary bring-ins answered busy beside one another on an idle process (a
 * reservation of each request's worst case), a request that keeps reading or
 * asking CommCare HQ after the meter refused it, an answer other than busy
 * from a request the meter stopped, a request stopped between its writes, and
 * a lease never given back (after an answer, a throw or a cancelled request)
 * are what these catch.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { withSocketHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedHqAnswer,
	retainedBodyJson,
	retainedBodyText,
	retainedGroupRead,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import {
	chargeHeld,
	type MemoryLease,
	processMemoryMeter,
	READING_HEAP_PER_SOURCE_BYTE,
	SECOND_READING_HEAP_PER_SOURCE_BYTE,
	TEXT_HEAP_PER_WIRE_BYTE,
} from "@/lib/commcare/hq/memoryMeter";
import type { LookupRevision } from "@/lib/lookup/types";
import { type GatherResult, gatherFromHq } from "../gather";
import type { MediaStaging } from "../projectData/mediaStore";
import type { ReadingProjectSide } from "../projectData/read";
import {
	holdChangesReadings,
	holdReading,
	noRoomFinding,
	withBringInRoom,
} from "../room";

/** A create's staging held in this test: each content is named, never written. */
const TEST_STAGING: MediaStaging = {
	stage: async (file) => ({
		gcsObjectKey: `pending/test/${file.contentHash}`,
		generation: "1",
		checksum: "test",
	}),
	discard: async () => {},
};

const HOSTNAME = "india.commcarehq.org";
const DOMAIN = "clinic";
const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const APP = retainedBodyJson(retainedReadingRead("application")).id as string;
const KEY = {
	projectId: "room-project",
	server: "india",
	domain: DOMAIN,
	remoteAppId: APP,
} as const;

const PATHS = {
	application: `/a/${DOMAIN}/api/application/v1/${APP}/`,
	source: `/a/${DOMAIN}/apps/source/${APP}/`,
	version: `/a/${DOMAIN}/apps/view/${APP}/current_version/`,
	tables: `/a/${DOMAIN}/api/lookup_table/v1/?limit=1000`,
};

/** A Project that holds no table. */
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
 * The application resource and the source of `navigation-base`, its one menu
 * under fresh ids, as the cap test builds them, at one menu: an ordinary app.
 */
function ordinaryApp(): {
	readonly application: RetainedHqAnswer;
	readonly source: RetainedHqAnswer;
} {
	const retainedApplication = retainedReadingRead("application");
	const application = retainedBodyJson(retainedApplication);
	const retainedSource = retainedGroupRead("navigation-base/app-source");
	const source = retainedBodyJson(retainedSource);
	const [summary] = application.modules as Record<string, unknown>[];
	const [menu] = source.modules as Record<string, unknown>[];
	if (menu === undefined) throw new Error("navigation-base holds no menu.");
	const attachments = source._attachments as Record<string, string>;
	const sourceForms = (menu.forms as { unique_id: string }[]).map(
		(form) => form.unique_id,
	);
	const held: Record<string, string> = {};
	for (const id of sourceForms)
		held[`${id}.xml`] = attachments[`${id}.xml`] as string;
	return {
		application: {
			...retainedApplication,
			body: JSON.stringify({ ...application, modules: [summary] }),
		},
		source: {
			...retainedSource,
			body: JSON.stringify({
				...source,
				modules: [menu],
				_attachments: held,
			}),
		},
	};
}

/** A peer serving `app` as CommCare HQ does, recording every path it was asked. */
function serving(app: ReturnType<typeof ordinaryApp>, asked: string[]) {
	return (request: IncomingMessage, response: ServerResponse) => {
		asked.push(request.url ?? "");
		if (request.url === PATHS.application) send(response, app.application);
		else if (request.url === PATHS.source) send(response, app.source);
		else if (request.url === PATHS.version)
			send(response, retainedReadingRead("current-version"));
		else if (request.url === PATHS.tables) send(response, noTables());
		else {
			response.writeHead(404);
			response.end();
		}
	};
}

/** One read of the app for a bring-in, in the room, as `read.ts` runs it. */
function readInRoom(
	work: "review" | "create",
	options: { readonly cancel?: AbortSignal } = {},
): Promise<GatherResult | "busy"> {
	return withBringInRoom<GatherResult | "busy">(
		work,
		async (room) =>
			(
				await gatherFromHq({
					key: KEY,
					readingId: "019a7f3c-2b1d-7e40-8a9b-0c1d2e3f4a5b",
					appId: "5b0c8d6e-2f1a-4c3b-9e7d-6a5b4c3d2e1f",
					stageMedia: work === "create" ? TEST_STAGING : null,
					onEvent: () => {},
					cancel:
						options.cancel === undefined
							? room.signal
							: AbortSignal.any([options.cancel, room.signal]),
					creds: CREDS,
					project: NOTHING,
				})
			).result,
		() => "busy" as const,
	);
}

/**
 * A lease opened before the request, the oldest, holding the whole of the
 * process's heap bound but `leftWireBytes` of text: every lease after it is
 * refused once it passes that.
 */
function fillTheHeap(leftWireBytes: number): MemoryLease {
	const meter = processMemoryMeter();
	const lease = meter.open();
	const room = Math.floor(meter.bounds.heap / TEXT_HEAP_PER_WIRE_BYTE);
	expect(lease.charge("text", room - leftWireBytes)).toBe(true);
	return lease;
}

afterEach(() => {
	expect(processMemoryMeter().held()).toEqual({ heap: 0, external: 0 });
	expect(processMemoryMeter().openLeases()).toBe(0);
});

describe("withBringInRoom", () => {
	it("runs several bring-ins of ordinary apps at once, each charged by what it read, and gives every lease back", async () => {
		const app = ordinaryApp();
		const asked: string[] = [];
		const held: number[] = [];
		await withSocketHttpPeer(HOSTNAME, serving(app, asked), async () => {
			const results = await Promise.all(
				["create", "create", "create", "review", "review"].map((work) =>
					withBringInRoom<string>(
						work as "create" | "review",
						async (room) => {
							const answer = await gatherFromHq({
								key: KEY,
								readingId: "019a7f3c-2b1d-7e40-8a9b-0c1d2e3f4a5b",
								appId: "5b0c8d6e-2f1a-4c3b-9e7d-6a5b4c3d2e1f",
								stageMedia: work === "create" ? TEST_STAGING : null,
								onEvent: () => {},
								cancel: room.signal,
								creds: CREDS,
								project: NOTHING,
							});
							held.push(processMemoryMeter().held().heap);
							return answer.result.kind;
						},
						() => "busy" as const,
					),
				),
			);
			expect(results).toEqual(["clean", "clean", "clean", "clean", "clean"]);
		});
		/* Each charged what it read, a few megabytes of the bound at most. */
		expect(Math.max(...held)).toBeGreaterThan(0);
		expect(Math.max(...held)).toBeLessThan(processMemoryMeter().bounds.heap);
	}, 60_000);

	it("stops a request whose read would pass the bound partway: no request after it goes to CommCare HQ, and it answers busy", async () => {
		const app = ordinaryApp();
		const asked: string[] = [];
		const full = fillTheHeap(1024);
		try {
			await withSocketHttpPeer(HOSTNAME, serving(app, asked), async () => {
				expect(await readInRoom("review")).toBe("busy");
			});
			/* The application resource was asked for and refused at its first
			 * bytes; nothing was asked after it, its one resend included. */
			expect(asked).toEqual([PATHS.application]);
			expect(processMemoryMeter().held().heap).toBe(full.held().heap);
		} finally {
			full.end();
		}
	}, 60_000);

	it("stops a request at its reading's charge, before the source is read as one", async () => {
		const app = ordinaryApp();
		const asked: string[] = [];
		const wire =
			Buffer.byteLength(retainedBodyText(app.application)) +
			Buffer.byteLength(retainedBodyText(app.source)) +
			Buffer.byteLength(
				retainedBodyText(retainedReadingRead("current-version")),
			);
		/* Room for the three bodies, and none for the reading. */
		const full = fillTheHeap(wire + 64);
		try {
			await withSocketHttpPeer(HOSTNAME, serving(app, asked), async () => {
				expect(await readInRoom("review")).toBe("busy");
			});
			expect(asked).toEqual([PATHS.application, PATHS.source, PATHS.version]);
		} finally {
			full.end();
		}
	}, 60_000);

	it("answers busy whatever the request answered or threw once its lease was refused, and rethrows what a request threw with room", async () => {
		const full = fillTheHeap(0);
		try {
			let after = false;
			expect(
				await withBringInRoom(
					"review",
					async (room) => {
						expect(holdReading(1)).toBe(false);
						expect(room.signal.aborted).toBe(true);
						after = true;
						return "answered";
					},
					() => "busy",
				),
			).toBe("busy");
			expect(after).toBe(true);
			expect(
				await withBringInRoom(
					"changes-review",
					async () => {
						chargeHeld("text", 1);
						throw new Error("a read that failed because the meter stopped it");
					},
					() => "busy",
				),
			).toBe("busy");
		} finally {
			full.end();
		}
		await expect(
			withBringInRoom(
				"changes-bring-in",
				async () => {
					throw new Error("the request failed");
				},
				() => "busy",
			),
		).rejects.toThrow("the request failed");
	});

	it("writes nothing where a charge was refused before the writes, and refuses nothing once they began", async () => {
		const full = fillTheHeap(0);
		try {
			const wrote: string[] = [];
			expect(
				await withBringInRoom(
					"create",
					async (room) => {
						chargeHeld("bytes", 1);
						chargeHeld("text", 1);
						room.beginWrites();
						wrote.push("the app");
						return "created";
					},
					() => "busy",
				),
			).toBe("busy");
			expect(wrote).toEqual([]);
			expect(
				await withBringInRoom(
					"create",
					async (room) => {
						room.beginWrites();
						expect(chargeHeld("text", 1024)).toBe(true);
						expect(holdReading(1024)).toBe(true);
						wrote.push("the app");
						return "created";
					},
					() => "busy",
				),
			).toBe("created");
			expect(wrote).toEqual(["the app"]);
		} finally {
			full.end();
		}
	});

	it("charges a changes review's two readings once, at the measured rates, however often the request reviews", async () => {
		const meter = processMemoryMeter();
		const before = meter.held().heap;
		/* Sizes the second rate divides evenly, so each charge is exact. */
		const base = 30 * READING_HEAP_PER_SOURCE_BYTE;
		const now = 10 * READING_HEAP_PER_SOURCE_BYTE;
		await withBringInRoom(
			"changes-bring-in",
			async () => {
				expect(holdChangesReadings(base, 0)).toBe(true);
				expect(meter.held().heap - before).toBe(
					base * READING_HEAP_PER_SOURCE_BYTE,
				);
				expect(holdChangesReadings(base, now)).toBe(true);
				const once =
					base * READING_HEAP_PER_SOURCE_BYTE +
					now * SECOND_READING_HEAP_PER_SOURCE_BYTE;
				expect(meter.held().heap - before).toBe(once);
				/* A review again, and the check once more after the writes began. */
				expect(holdChangesReadings(base, 0)).toBe(true);
				expect(holdChangesReadings(base, now)).toBe(true);
				expect(meter.held().heap - before).toBe(once);
				/* A larger source now adds only what it adds. */
				expect(holdChangesReadings(base, 2 * base)).toBe(true);
				expect(meter.held().heap - before).toBe(
					2 * base * READING_HEAP_PER_SOURCE_BYTE +
						base * SECOND_READING_HEAP_PER_SOURCE_BYTE,
				);
				return "reviewed";
			},
			() => "busy",
		);
		expect(meter.held().heap).toBe(before);
	});

	it("gives the lease back when the request's caller cancels it mid-read", async () => {
		const cancel = new AbortController();
		const app = ordinaryApp();
		await withSocketHttpPeer(
			HOSTNAME,
			(request: IncomingMessage, response: ServerResponse) => {
				if (request.url === PATHS.application) {
					/* Half the body, then nothing, until the caller cancels. */
					const body = retainedBodyText(app.application);
					response.writeHead(200, { "content-type": "application/json" });
					response.write(body.slice(0, body.length / 2));
					cancel.abort();
				} else {
					response.writeHead(404);
					response.end();
				}
			},
			async () => {
				const answer = await readInRoom("review", { cancel: cancel.signal });
				expect(answer).not.toBe("busy");
				expect(answer).toMatchObject({ kind: "stop" });
			},
		);
	}, 60_000);
});

describe("noRoomFinding", () => {
	it("is the nova-busy stop at the app", () => {
		expect(noRoomFinding()).toMatchObject({
			code: "nova-busy",
			place: { kind: "app" },
		});
	});
});
