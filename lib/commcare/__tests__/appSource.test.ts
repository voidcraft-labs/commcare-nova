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
	type RetainedHqAnswer,
	type RetainedPublishRead,
	replyRetained,
	retainedBodyJson,
	retainedBodyText,
	retainedGroupRead,
	retainedPublishRead,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { type ReadHqAppSourceOptions, readHqAppSource } from "../hq/appSource";

const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const HOST = "https://india.commcarehq.org";
const PATH = "/a/clinic/apps/source/working-app/";
const read = (options?: ReadHqAppSourceOptions) =>
	readHqAppSource(CREDS, "clinic", "working-app", options);
const MALFORMED = { success: false, status: 502, cause: "malformed" };
afterEach(() => vi.useRealTimers());

type Peer = Parameters<Parameters<typeof withHttpPeer>[0]>[0];

function serve(peer: Peer, name: RetainedPublishRead) {
	serveAnswer(peer, retainedPublishRead(name));
}

function serveAnswer(peer: Peer, answer: RetainedHqAnswer) {
	replyRetained(
		peer.get(HOST).intercept({
			path: PATH,
			method: "GET",
			headers: { authorization: "ApiKey account:key" },
		}),
		answer,
	);
}

/** A retained answer with its body changed. */
function changed(
	answer: RetainedHqAnswer,
	change: (body: Record<string, unknown>) => void,
): RetainedHqAnswer {
	const body = structuredClone(retainedBodyJson(answer));
	change(body);
	return { ...answer, body: JSON.stringify(body) };
}

/** Read one answer under both modes, the default first. */
async function readUnderBoth(answer: RetainedHqAnswer) {
	return withHttpPeer(async (peer) => {
		serveAnswer(peer, answer);
		serveAnswer(peer, answer);
		const plain = await read();
		const any = await read({ admit: "any" });
		return { plain, any };
	});
}

function sourceOf(result: Awaited<ReturnType<typeof read>>) {
	if (!("kind" in result) || result.kind !== "source")
		throw new Error(`Expected a source, got ${JSON.stringify(result)}`);
	return result.source;
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

	it("reads source-missing as gone", async () => {
		await withHttpPeer(async (peer) => {
			serve(peer, "source-missing");
			expect(await read()).toEqual({ kind: "gone", deleted: false });
		});
	});

	it("reads source-deleted as gone and deleted, a working app by its empty build date", async () => {
		await withHttpPeer(async (peer) => {
			serve(peer, "source-deleted");
			expect(await read()).toEqual({
				kind: "gone",
				deleted: true,
				mayBeBuild: false,
			});
		});
	});

	it("reads a deleted document with a build date as one that may be a build", async () => {
		/* A build holds one, and so does a working app reverted to a build. */
		await withHttpPeer(async (peer) => {
			serveAnswer(
				peer,
				changed(retainedPublishRead("source-deleted"), (body) => {
					body.built_on = "2026-10-05T10:02:19.000000Z";
				}),
			);
			expect(await read()).toEqual({
				kind: "gone",
				deleted: true,
				mayBeBuild: true,
			});
		});
	});

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

	it("reads the app's name, when HQ last saved it and its media map as stored", async () => {
		const answer = retainedGroupRead("case-list-inline/app-source-after-media");
		const body = retainedBodyJson(answer);
		const { plain } = await readUnderBoth(answer);
		const source = sourceOf(plain);
		expect(source.name).toBe(body.name);
		expect(source.lastModified).toBe(body.last_modified);
		const [[path, entry]] = Object.entries(
			body.multimedia_map as Record<string, Record<string, unknown>>,
		);
		expect(source.multimediaMap).toEqual([
			{
				path,
				multimediaId: entry.multimedia_id,
				mediaType: entry.media_type,
				unreadable: false,
			},
		]);
		expect(source.buildProfiles).toEqual([]);
	});

	it("keeps a media map whose entries name no file or one Nova cannot ask for, and still reads the source", async () => {
		const answer = retainedGroupRead("case-list-inline/app-source-after-media");
		const map = retainedBodyJson(answer).multimedia_map as Record<
			string,
			Record<string, unknown>
		>;
		const [[path, entry]] = Object.entries(map);
		const { plain } = await readUnderBoth(
			changed(answer, (body) => {
				body.multimedia_map = {
					[path]: { ...entry, multimedia_id: "../other" },
					"jr://file/commcare/no-id.png": { ...entry, multimedia_id: null },
					"jr://file/commcare/odd-type.png": {
						...entry,
						media_type: "CommCareText",
					},
					"jr://file/commcare/no-object.png": "file",
					"jr://file/commcare/kept.png": entry,
				};
			}),
		);
		expect(sourceOf(plain).multimediaMap).toEqual([
			{ path, multimediaId: null, mediaType: null, unreadable: true },
			{
				path: "jr://file/commcare/no-id.png",
				multimediaId: null,
				mediaType: null,
				unreadable: false,
			},
			{
				path: "jr://file/commcare/odd-type.png",
				multimediaId: null,
				mediaType: null,
				unreadable: true,
			},
			{
				path: "jr://file/commcare/no-object.png",
				multimediaId: null,
				mediaType: null,
				unreadable: true,
			},
			{
				path: "jr://file/commcare/kept.png",
				multimediaId: entry.multimedia_id,
				mediaType: entry.media_type,
				unreadable: false,
			},
		]);
	});

	it("reads no name, no save time and no media map where HQ sent none, and refuses nothing for them", async () => {
		const { plain } = await readUnderBoth(
			changed(retainedPublishRead("source-live"), (body) => {
				body.name = 7;
				delete body.last_modified;
				body.multimedia_map = [];
			}),
		);
		const source = sourceOf(plain);
		expect(source.name).toBeNull();
		expect(source.lastModified).toBeNull();
		expect(source.multimediaMap).toBeNull();
	});

	it.each(["hq-built/app-source", "reading/source-shadow"])(
		"refuses %s under the default and reads it with its mirror menus and shadow form under admit any",
		async (file) => {
			const answer =
				file === "reading/source-shadow"
					? retainedReadingRead("source-shadow")
					: retainedGroupRead(file);
			const sent = retainedBodyJson(answer).modules as Record<
				string,
				unknown
			>[];
			const { plain, any } = await readUnderBoth(answer);
			expect(plain).toEqual(MALFORMED);
			const source = sourceOf(any);
			expect(source.modules.map((module) => module.docType)).toEqual(
				sent.map((module) => module.doc_type),
			);
			for (const [i, module] of source.modules.entries()) {
				expect(module.caseType).toBe(sent[i].case_type);
				if (module.docType === "ShadowModule")
					expect(module.caseType).toBeNull();
			}
			const forms = source.modules.flatMap((module) => module.forms);
			const shadow = forms.find((form) => form.docType === "ShadowForm");
			if (shadow === undefined) throw new Error("Expected a shadow form");
			expect(shadow.xmlns).toBeNull();
			const parent = forms.find(
				(form) => form.readUniqueId === shadow.shadowParentReadId,
			);
			expect(parent?.docType).toBe("AdvancedForm");
			expect(parent?.xmlns).not.toBeNull();
			for (const form of forms)
				if (form !== shadow) expect(form.shadowParentReadId).toBeNull();
		},
	);

	it("reads the two mirror menus of the shadow state with no case type", async () => {
		const source = sourceOf(
			(await readUnderBoth(retainedReadingRead("source-shadow"))).any,
		);
		const mirrors = source.modules.filter(
			(module) => module.docType === "ShadowModule",
		);
		expect(mirrors).toHaveLength(2);
		for (const mirror of mirrors)
			expect(mirror).toMatchObject({ caseType: null, forms: [] });
		const report = source.modules.find(
			(module) => module.docType === "ReportModule",
		);
		expect(report?.caseType).toBe("");
	});

	it.each([
		[
			"removed",
			(module: Record<string, unknown>) => {
				delete module.unique_id;
			},
		],
		[
			"null",
			(module: Record<string, unknown>) => {
				module.unique_id = null;
			},
		],
	])(
		"refuses a menu whose unique_id is %s under the default and reads it with no id under admit any",
		async (_, change) => {
			const { plain, any } = await readUnderBoth(
				changed(retainedPublishRead("source-live"), (body) => {
					change(firstModule(body));
				}),
			);
			expect(plain).toEqual(MALFORMED);
			expect(sourceOf(any).modules[0].uniqueId).toBeNull();
		},
	);

	it("reads an empty unique_id as itself under the default and as no id under admit any", async () => {
		const { plain, any } = await readUnderBoth(
			changed(retainedPublishRead("source-live"), (body) => {
				firstModule(body).unique_id = "";
			}),
		);
		expect(sourceOf(plain).modules[0].uniqueId).toBe("");
		expect(sourceOf(any).modules[0].uniqueId).toBeNull();
	});

	it.each([
		[
			"a numeric unique_id",
			(body: Record<string, unknown>) => {
				firstModule(body).unique_id = 7;
			},
		],
		[
			"a menu with no doc_type",
			(body: Record<string, unknown>) => {
				delete firstModule(body).doc_type;
			},
		],
		[
			"a numeric case_type",
			(body: Record<string, unknown>) => {
				firstModule(body).case_type = 7;
			},
		],
	])(
		"refuses %s under admit any as under the default",
		async (name, change) => {
			const { plain, any } = await readUnderBoth(
				changed(retainedPublishRead("source-live"), change),
			);
			expect(any).toEqual(MALFORMED);
			if (name === "a menu with no doc_type")
				expect(sourceOf(plain).modules[0].docType).toBe("");
			else expect(plain).toEqual(MALFORMED);
		},
	);

	it("reads a build profile HQ holds, with its languages", async () => {
		const { plain, any } = await readUnderBoth(
			retainedGroupRead(
				"targeted-hq-side-state/app-source-after-buildProfiles",
			),
		);
		const expected = [
			{ id: "mandarin-only", name: "Mandarin", langs: ["zho"] },
		];
		expect(sourceOf(plain).buildProfiles).toEqual(expected);
		expect(sourceOf(any).buildProfiles).toEqual(expected);
	});

	it("reads an app with no build profile as none", async () => {
		const { plain } = await readUnderBoth(
			changed(retainedPublishRead("source-live"), (body) => {
				body.build_profiles = {};
			}),
		);
		expect(sourceOf(plain).buildProfiles).toEqual([]);
	});

	it.each([
		[
			"no build_profiles",
			(body: Record<string, unknown>) => {
				delete body.build_profiles;
			},
		],
		[
			"a profile with no langs list",
			(body: Record<string, unknown>) => {
				body.build_profiles = { mandarin: { name: "Mandarin", langs: "zho" } };
			},
		],
		[
			"build_profiles as a list",
			(body: Record<string, unknown>) => {
				body.build_profiles = [{ name: "Mandarin", langs: ["zho"] }];
			},
		],
		[
			"a profile whose langs hold a number",
			(body: Record<string, unknown>) => {
				body.build_profiles = { mandarin: { name: "Mandarin", langs: [7] } };
			},
		],
	])(
		"refuses a source with %s under both modes, never reading it as no profile",
		async (_, change) => {
			const { plain, any } = await readUnderBoth(
				changed(retainedPublishRead("source-live"), change),
			);
			expect(plain).toEqual(MALFORMED);
			expect(any).toEqual(MALFORMED);
		},
	);

	it("reads a profile with no string name as unnamed", async () => {
		const { plain } = await readUnderBoth(
			changed(retainedPublishRead("source-live"), (body) => {
				body.build_profiles = { mandarin: { name: null, langs: ["zho"] } };
			}),
		);
		expect(sourceOf(plain).buildProfiles).toEqual([
			{ id: "mandarin", name: "", langs: ["zho"] },
		]);
	});

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
				cause: "too-large",
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
