/**
 * `readHqAppSource` over CommCare HQ's own answers.
 *
 * Every answer served here is one the proof lane retained from HQ's views
 * (`proof/hq-reads/publish/`), or that answer with one key removed: the
 * reader's job is to say what HQ holds, so its cases are HQ's states, never
 * shapes written by hand.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedPublishRead,
	replyRetained,
	retainedBodyJson,
	retainedBodyText,
	retainedPublishRead,
} from "@/__tests__/helpers/retainedHqReads";
import { readHqAppSource } from "../hq/appSource";

const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const HOST = "https://india.commcarehq.org";
const PATH = "/a/clinic/apps/source/working-app/";
const read = (options?: { maxBytes?: number }) =>
	readHqAppSource(CREDS, "clinic", "working-app", options);
afterEach(() => vi.useRealTimers());

function serve(
	peer: Parameters<Parameters<typeof withHttpPeer>[0]>[0],
	name: RetainedPublishRead,
) {
	replyRetained(
		peer.get(HOST).intercept({
			path: PATH,
			method: "GET",
			headers: { authorization: "ApiKey account:key" },
		}),
		retainedPublishRead(name),
	);
}

/** The retained live read with one change, for the shape refusals. */
function liveWith(
	change: (body: Record<string, unknown>) => void,
): Record<string, unknown> {
	const body = structuredClone(
		retainedBodyJson(retainedPublishRead("source-live")),
	);
	change(body);
	return body;
}

function firstModule(body: Record<string, unknown>): Record<string, unknown> {
	return (body.modules as Record<string, unknown>[])[0];
}

describe("readHqAppSource", () => {
	it("reads a live app: its version, profile, languages, menus and each form's XForm through this read's own form ids", async () => {
		await withHttpPeer(async (peer) => {
			serve(peer, "source-live");
			const result = await read();
			if (!("kind" in result) || result.kind !== "source")
				throw new Error(`Expected a source, got ${JSON.stringify(result)}`);
			const body = retainedBodyJson(retainedPublishRead("source-live"));
			const source = result.source;
			expect(source.docType).toBe("Application");
			expect(source.buildSpecVersion).toBe(
				(body.build_spec as { version: string }).version,
			);
			expect(source.profile).toEqual(body.profile);
			expect(source.langs).toEqual(body.langs);
			expect(source.translations).toEqual(body.translations);
			expect(source.addOns).toEqual(body.add_ons);
			expect(source.cloudcareEnabled).toBe(body.cloudcare_enabled === true);
			expect(source.logoRefs).toEqual(body.logo_refs ?? {});
			expect(source.raw).toEqual(body);
			expect(source.modules.length).toBeGreaterThan(0);
			const attachments = body._attachments as Record<string, string>;
			for (const [index, module] of source.modules.entries()) {
				const sent = (body.modules as Record<string, unknown>[])[index];
				expect(module.uniqueId).toBe(sent.unique_id);
				expect(module.caseType).toBe(sent.case_type);
				for (const form of module.forms) {
					expect(form.attachment).toBe(attachments[`${form.readUniqueId}.xml`]);
					expect(form.attachment).not.toBeNull();
				}
			}
		});
	});

	it("reads the empty shell a first publish creates as a source with no menus", async () => {
		await withHttpPeer(async (peer) => {
			serve(peer, "source-shell");
			const result = await read();
			if (!("kind" in result) || result.kind !== "source")
				throw new Error(`Expected a source, got ${JSON.stringify(result)}`);
			expect(result.source.modules).toEqual([]);
		});
	});

	it("pairs attachments through the response's own forms and ignores the orphans an old create left", async () => {
		await withHttpPeer(async (peer) => {
			serve(peer, "source-after-create-then-update");
			const result = await read();
			if (!("kind" in result) || result.kind !== "source")
				throw new Error(`Expected a source, got ${JSON.stringify(result)}`);
			const body = retainedBodyJson(
				retainedPublishRead("source-after-create-then-update"),
			);
			const attachments = body._attachments as Record<string, string>;
			const forms = result.source.modules.flatMap((module) => module.forms);
			/* The orphans are there to ignore: more XForms than forms. */
			expect(
				Object.keys(attachments).filter((key) => key.endsWith(".xml")).length,
			).toBeGreaterThan(forms.length);
			for (const form of forms) {
				expect(form.attachment).toBe(attachments[`${form.readUniqueId}.xml`]);
			}
		});
	});

	it.each(["source-missing", "source-deleted"] as const)(
		"reads %s as gone",
		async (name) => {
			await withHttpPeer(async (peer) => {
				serve(peer, name);
				expect(await read()).toEqual({ kind: "gone" });
			});
		},
	);

	it("reads a linked app as unsupported, naming its doc_type", async () => {
		await withHttpPeer(async (peer) => {
			serve(peer, "source-linked");
			expect(await read()).toEqual({
				kind: "unsupported",
				docType: "LinkedApplication",
			});
		});
	});

	it.each([
		[
			"a module with no string unique_id",
			(body: Record<string, unknown>) => {
				delete firstModule(body).unique_id;
			},
		],
		[
			"a module with no string case_type",
			(body: Record<string, unknown>) => {
				delete firstModule(body).case_type;
			},
		],
		[
			"a form with no string xmlns",
			(body: Record<string, unknown>) => {
				delete (firstModule(body).forms as Record<string, unknown>[])[0].xmlns;
			},
		],
		[
			"no langs",
			(body: Record<string, unknown>) => {
				delete body.langs;
			},
		],
		[
			"no build_spec.version",
			(body: Record<string, unknown>) => {
				delete (body.build_spec as Record<string, unknown>).version;
			},
		],
		[
			"no profile",
			(body: Record<string, unknown>) => {
				delete body.profile;
			},
		],
		[
			"no translations",
			(body: Record<string, unknown>) => {
				delete body.translations;
			},
		],
		[
			"no add_ons",
			(body: Record<string, unknown>) => {
				delete body.add_ons;
			},
		],
		[
			"no _attachments",
			(body: Record<string, unknown>) => {
				delete body._attachments;
			},
		],
		[
			"a logo_refs that is not an object",
			(body: Record<string, unknown>) => {
				body.logo_refs = ["hq_logo_web_apps"];
			},
		],
	])(
		"refuses the live read with %s, never defaulting it",
		async (_, change) => {
			await withHttpPeer(async (peer) => {
				peer
					.get(HOST)
					.intercept({ path: PATH, method: "GET" })
					.reply(200, JSON.stringify(liveWith(change)));
				expect(await read()).toEqual({
					success: false,
					status: 502,
					cause: "malformed",
				});
			});
		},
	);

	it("reads Web Apps as off and no logo slot where HQ holds them so", async () => {
		await withHttpPeer(async (peer) => {
			peer
				.get(HOST)
				.intercept({ path: PATH, method: "GET" })
				.reply(
					200,
					JSON.stringify(
						liveWith((body) => {
							body.cloudcare_enabled = false;
							delete body.logo_refs;
						}),
					),
				);
			const result = await read();
			if (!("kind" in result) || result.kind !== "source")
				throw new Error(`Expected a source, got ${JSON.stringify(result)}`);
			expect(result.source.cloudcareEnabled).toBe(false);
			expect(result.source.logoRefs).toEqual({});
		});
	});

	it("refuses a body one byte longer than its bound, and reads it at the bound", async () => {
		const bytes = Buffer.byteLength(
			retainedBodyText(retainedPublishRead("source-live")),
		);
		await withHttpPeer(async (peer) => {
			serve(peer, "source-live");
			serve(peer, "source-live");
			expect(await read({ maxBytes: bytes - 1 })).toEqual({
				success: false,
				status: 502,
				cause: "malformed",
			});
			expect(await read({ maxBytes: bytes })).toMatchObject({
				kind: "source",
			});
		});
	});

	it("keeps refusals and disconnects explicit and follows no redirect", async () => {
		await withHttpPeer(async (peer) => {
			for (const status of [401, 403, 503, 302]) {
				peer
					.get(HOST)
					.intercept({ path: PATH, method: "GET" })
					.reply(status, "Refused", {
						headers: { location: "/a/other/apps/source/working-app/" },
					});
				expect(await read()).toEqual({
					success: false,
					status,
					edgeRefusal: false,
				});
			}
			peer
				.get(HOST)
				.intercept({ path: PATH, method: "GET" })
				.replyWithError(new Error("connection lost"));
			expect(await read()).toEqual({
				success: false,
				status: 503,
				cause: "network",
			});
		});
	});

	it("rejects an invalid project or app path before requesting source", async () => {
		await withHttpPeer(async (peer) => {
			for (const [domain, app] of [
				[".", "working-app"],
				["..", "working-app"],
				["clinic/space", "working-app"],
				["clinic", ".."],
				["clinic", "../other"],
				["clinic", ""],
			])
				expect(await readHqAppSource(CREDS, domain, app)).toEqual({
					success: false,
					status: 400,
				});
			expect(peer.getCallHistory()?.calls()).toEqual([]);
		});
	});

	it("aborts an unanswered source request and releases its sole deadline", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await withHttpPeer(async (peer) => {
			const reached = Promise.withResolvers<void>(),
				release = Promise.withResolvers<void>();
			const shell = retainedPublishRead("source-shell");
			peer
				.get(HOST)
				.intercept({ path: PATH, method: "GET" })
				.reply(async () => {
					reached.resolve();
					await release.promise;
					return { statusCode: 200, data: retainedBodyText(shell) };
				});
			const pending = read();
			try {
				await reached.promise;
				await vi.advanceTimersByTimeAsync(30_000);
				expect(await pending).toEqual({
					success: false,
					status: 503,
					cause: "timeout",
				});
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				release.resolve();
				await pending;
			}
		});
	});
});
