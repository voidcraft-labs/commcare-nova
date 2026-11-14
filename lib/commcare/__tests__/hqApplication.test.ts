/**
 * The application resource's one reader, over CommCare HQ's own answers
 * (`proof/hq-reads/reading/`), or such an answer with one key changed.
 *
 * Form ids taken from a build, one bad menu losing every id, a silent skip
 * of an unreadable question, and a mirror menu refused as malformed are what
 * these cases would catch.
 */

import type { MockAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	applicationAnswer,
	type RetainedHqAnswer,
	type RetainedReadingRead,
	replyRetained,
	retainedBodyJson,
	retainedBodyText,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import {
	type HqApplication,
	hqApplicationModules,
	readHqApplication,
} from "../hq/application";

const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const HOST = "https://india.commcarehq.org";
/** The id every retained answer of the live app names. */
const APP = retainedBodyJson(retainedReadingRead("application")).id as string;
const pathOf = (appId: string) => `/a/clinic/api/application/v1/${appId}/`;
const MALFORMED = { success: false, status: 502, cause: "malformed" };
afterEach(() => vi.useRealTimers());

function serve(peer: MockAgent, appId: string, answer: RetainedHqAnswer) {
	replyRetained(
		peer.get(HOST).intercept({
			path: pathOf(appId),
			method: "GET",
			headers: { authorization: "ApiKey account:key" },
		}),
		answer,
	);
}

async function readRetained(
	name: RetainedReadingRead,
): Promise<{ application: HqApplication; body: Record<string, unknown> }> {
	const answer = retainedReadingRead(name);
	const body = retainedBodyJson(answer);
	const appId = body.id as string;
	return withHttpPeer(async (peer) => {
		serve(peer, appId, answer);
		const application = await readHqApplication(CREDS, "clinic", appId);
		if ("success" in application)
			throw new Error(
				`Expected an application, got ${JSON.stringify(application)}`,
			);
		return { application, body };
	});
}

/** The retained `application` body with one change, served for the live app. */
function applicationWith(
	change: (body: Record<string, unknown>) => void,
): RetainedHqAnswer {
	const answer = retainedReadingRead("application");
	const body = structuredClone(retainedBodyJson(answer));
	change(body);
	return { ...answer, body: JSON.stringify(body) };
}

function firstModule(body: Record<string, unknown>): Record<string, unknown> {
	return (body.modules as Record<string, unknown>[])[0];
}

async function modulesOf(answer: RetainedHqAnswer) {
	return withHttpPeer(async (peer) => {
		serve(peer, APP, answer);
		const application = await readHqApplication(CREDS, "clinic", APP);
		if ("success" in application)
			throw new Error(
				`Expected an application, got ${JSON.stringify(application)}`,
			);
		return hqApplicationModules(application);
	});
}

describe("readHqApplication", () => {
	it("reads the live app's envelope, its builds and its real form ids with HQ's question summary", async () => {
		const { application, body } = await readRetained("application");
		expect(application).toMatchObject({
			appId: APP,
			name: body.name,
			version: body.version,
			builtFromAppId: null,
		});
		expect(application.builds).toEqual(
			(body.versions as Record<string, unknown>[]).map((row) => ({
				id: row.id,
				version: row.version,
				isReleased: row.is_released,
				builtOn: row.built_on,
				buildComment: row.build_comment,
			})),
		);
		const modules = hqApplicationModules(application);
		if ("malformedAt" in modules) throw new Error(modules.malformedAt);
		const sent = body.modules as Record<string, unknown>[];
		expect(modules).toHaveLength(sent.length);
		for (const [i, module] of modules.entries()) {
			if (module.kind !== "summarized") throw new Error("Expected a summary");
			expect(module.uniqueId).toBe(sent[i].unique_id);
			expect(module.caseType).toBe(sent[i].case_type);
			const forms = sent[i].forms as Record<string, unknown>[];
			expect(module.forms.map((form) => [form.uniqueId, form.xmlns])).toEqual(
				forms.map((form) => [form.unique_id, form.xmlns]),
			);
		}
		const [visit, register] = (
			modules[0] as { forms: readonly { questions: readonly unknown[] }[] }
		).forms;
		expect(visit.questions).toEqual([
			{
				path: "/data/answer",
				tag: "input",
				type: "Text",
				repeat: null,
				group: null,
				isGroup: false,
				required: false,
				relevant: null,
				constraint: null,
				calculate: null,
				setvalue:
					"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/notes",
				labelTranslations: { en: "Notes" },
				options: null,
			},
		]);
		/* A node with no control: no `required`, no `is_group`, and its calculate. */
		expect(register.questions[2]).toMatchObject({
			path: "/data/nova_trimmed_name",
			tag: "hidden",
			type: "DataBindOnly",
			isGroup: false,
			required: null,
			labelTranslations: {},
		});
	});

	it("reads a menu HQ could not summarize as its error, and the menu after it whole", async () => {
		const { application, body } = await readRetained(
			"application-error-module",
		);
		const modules = hqApplicationModules(application);
		if ("malformedAt" in modules) throw new Error(modules.malformedAt);
		const sent = body.modules as Record<string, unknown>[];
		expect(modules[0]).toEqual({ kind: "error", message: sent[0].error });
		expect(modules[1]).toMatchObject({
			kind: "summarized",
			uniqueId: sent[1].unique_id,
			caseType: "patient",
			forms: [
				{
					uniqueId: (sent[1].forms as Record<string, unknown>[])[0].unique_id,
					questions: [],
				},
			],
		});
	});

	it("reads mirror menus, a report menu and a shadow form as HQ summarizes them", async () => {
		const { application } = await readRetained("application-shadow");
		const modules = hqApplicationModules(application);
		if ("malformedAt" in modules) throw new Error(modules.malformedAt);
		expect(modules.map((module) => module.kind)).toEqual([
			"summarized",
			"summarized",
			"summarized",
			"summarized",
			"error",
		]);
		const [, advanced, report, mirror, sourceless] = modules;
		if (
			advanced.kind !== "summarized" ||
			report.kind !== "summarized" ||
			mirror.kind !== "summarized"
		)
			throw new Error("Expected summaries");
		/* The shadow form is reported with its parent's `xmlns`. */
		expect(advanced.forms[2].xmlns).toBe(advanced.forms[0].xmlns);
		expect(advanced.forms[2].uniqueId).not.toBe(advanced.forms[0].uniqueId);
		expect(report).toMatchObject({ caseType: "", forms: [] });
		/* The mirror menu with its source menu's case type and no forms. */
		expect(mirror).toMatchObject({ caseType: "patient", forms: [] });
		/* The mirror menu whose source is gone: its case type is None, which HQ's map does not hold. */
		expect(sourceless).toEqual({ kind: "error", message: "None" });
	});

	it("exposes the working app a build was made from", async () => {
		const { application, body } = await readRetained("application-build");
		expect(application.builtFromAppId).toBe(APP);
		expect(application.appId).toBe(body.id);
		expect(application.builds).toEqual([]);
	});

	it("reads a linked app's answer, which summarizes no menu", async () => {
		const { application } = await readRetained("application-linked");
		expect(hqApplicationModules(application)).toEqual([]);
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
		[
			"empty",
			(module: Record<string, unknown>) => {
				module.unique_id = "";
			},
		],
	])(
		"reads a menu whose unique_id is %s as a summary with no id",
		async (_, change) => {
			const modules = await modulesOf(
				applicationWith((body) => {
					change(firstModule(body));
				}),
			);
			if ("malformedAt" in modules) throw new Error(modules.malformedAt);
			expect(modules[0]).toMatchObject({ kind: "summarized", uniqueId: null });
		},
	);

	it.each([
		[
			"modules[0]",
			"a numeric unique_id",
			(body: Record<string, unknown>) => {
				firstModule(body).unique_id = 7;
			},
		],
		[
			"modules[0]",
			"an error beside other keys",
			(body: Record<string, unknown>) => {
				firstModule(body).error = "Boom";
			},
		],
		[
			"modules[0].forms[1]",
			"a form with no unique_id",
			(body: Record<string, unknown>) => {
				delete (firstModule(body).forms as Record<string, unknown>[])[1]
					.unique_id;
			},
		],
		[
			"modules[0].forms[1].questions[2]",
			"a question without value",
			(body: Record<string, unknown>) => {
				const forms = firstModule(body).forms as Record<string, unknown>[];
				delete (forms[1].questions as Record<string, unknown>[])[2].value;
			},
		],
		[
			"modules[0].forms[0].questions[0]",
			"options that are no list",
			(body: Record<string, unknown>) => {
				const forms = firstModule(body).forms as Record<string, unknown>[];
				(forms[0].questions as Record<string, unknown>[])[0].options = {};
			},
		],
	])("gives %s for %s, and never skips it", async (path, _, change) => {
		expect(await modulesOf(applicationWith(change))).toEqual({
			malformedAt: path,
		});
	});

	it("reads inline choices with their labels", async () => {
		const modules = await modulesOf(
			applicationWith((body) => {
				const forms = firstModule(body).forms as Record<string, unknown>[];
				(forms[0].questions as Record<string, unknown>[])[0].options = [
					{ value: "yes", translations: { en: "Yes" } },
				];
			}),
		);
		if ("malformedAt" in modules) throw new Error(modules.malformedAt);
		const first = modules[0];
		if (first.kind !== "summarized") throw new Error("Expected a summary");
		expect(first.forms[0].questions[0].options).toEqual([
			{ value: "yes", labelTranslations: { en: "Yes" } },
		]);
	});

	it.each([
		[
			"an id other than the app asked for",
			(b: Record<string, unknown>) => {
				b.id = "other-app";
			},
		],
		[
			"no name",
			(b: Record<string, unknown>) => {
				delete b.name;
			},
		],
		[
			"a negative version",
			(b: Record<string, unknown>) => {
				b.version = -1;
			},
		],
		[
			"a numeric built_from_app_id",
			(b: Record<string, unknown>) => {
				b.built_from_app_id = 1;
			},
		],
		[
			"no modules",
			(b: Record<string, unknown>) => {
				delete b.modules;
			},
		],
		[
			"no versions",
			(b: Record<string, unknown>) => {
				delete b.versions;
			},
		],
	])("refuses the envelope with %s as malformed", async (_, change) => {
		await withHttpPeer(async (peer) => {
			serve(peer, APP, applicationWith(change));
			expect(await readHqApplication(CREDS, "clinic", APP)).toEqual(MALFORMED);
		});
	});

	it("requires a complete build inventory with unambiguous identities and release flags", async () => {
		const build = {
			id: "released-build",
			version: 2,
			is_released: true,
			built_on: "2026-09-01T00:00:00Z",
			build_comment: "Reviewed",
		};
		await withHttpPeer(async (peer) => {
			serve(peer, "working-app", applicationAnswer("working-app", [build]));
			const read = await readHqApplication(CREDS, "clinic", "working-app");
			if ("success" in read) throw new Error(JSON.stringify(read));
			expect(read.builds).toEqual([
				{
					id: "released-build",
					version: 2,
					isReleased: true,
					builtOn: "2026-09-01T00:00:00Z",
					buildComment: "Reviewed",
				},
			]);
			const invalid = [
				[null],
				[{}],
				[build, build],
				[{ ...build, id: ".." }],
				[{ ...build, version: -1 }],
				[{ ...build, is_released: "true" }],
				[{ id: "released-build", version: 2 }],
			];
			for (const versions of invalid) {
				serve(peer, "working-app", applicationAnswer("working-app", versions));
				expect(
					await readHqApplication(CREDS, "clinic", "working-app"),
					JSON.stringify(versions),
				).toEqual(MALFORMED);
			}
			serve(peer, "working-app", applicationAnswer("working-app", []));
			const none = await readHqApplication(CREDS, "clinic", "working-app");
			if ("success" in none) throw new Error(JSON.stringify(none));
			expect(none.builds).toEqual([]);
		});
	});

	it("keeps HQ's refusal of the plan, a removed app's 404 and a refused account as statuses", async () => {
		await withHttpPeer(async (peer) => {
			serve(peer, APP, retainedReadingRead("application-no-api-access"));
			expect(await readHqApplication(CREDS, "clinic", APP)).toEqual({
				success: false,
				status: 401,
				edgeRefusal: false,
				refusedBody: retainedBodyText(
					retainedReadingRead("application-no-api-access"),
				),
			});
			for (const name of [
				"application-remote",
				"application-no-permission",
			] as const) {
				const answer = retainedReadingRead(name);
				serve(peer, APP, answer);
				expect(await readHqApplication(CREDS, "clinic", APP)).toEqual({
					success: false,
					status: answer.status,
					edgeRefusal: false,
					refusedBody: "",
				});
			}
		});
	});

	it("refuses a body one byte longer than its bound, and reads it at the bound", async () => {
		const answer = retainedReadingRead("application");
		const bytes = Buffer.byteLength(retainedBodyText(answer));
		await withHttpPeer(async (peer) => {
			serve(peer, APP, answer);
			serve(peer, APP, answer);
			expect(
				await readHqApplication(CREDS, "clinic", APP, { maxBytes: bytes - 1 }),
			).toEqual({ success: false, status: 502, cause: "too-large" });
			expect(
				await readHqApplication(CREDS, "clinic", APP, { maxBytes: bytes }),
			).toMatchObject({ appId: APP });
		});
	});

	it("binds the request to one app, follows no redirect and bounds an unanswered request", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await withHttpPeer(async (peer) => {
			for (const appId of ["..", "", "../other", "working-app?latest=true"])
				expect(await readHqApplication(CREDS, "clinic", appId)).toEqual({
					success: false,
					status: 400,
				});
			peer
				.get(HOST)
				.intercept({ path: pathOf("working-app"), method: "GET" })
				.reply(302, "Moved", {
					headers: {
						location: pathOf("working-app").replace("clinic", "other"),
					},
				});
			expect(await readHqApplication(CREDS, "clinic", "working-app")).toEqual({
				success: false,
				status: 302,
				edgeRefusal: false,
				refusedBody: "Moved",
			});
			expect(vi.getTimerCount()).toBe(0);
			const reached = Promise.withResolvers<void>(),
				release = Promise.withResolvers<void>();
			peer
				.get(HOST)
				.intercept({ path: pathOf("working-app"), method: "GET" })
				.reply(async () => {
					reached.resolve();
					await release.promise;
					return { statusCode: 200, data: "{}" };
				});
			const pending = readHqApplication(CREDS, "clinic", "working-app");
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
			expect(
				peer
					.getCallHistory()
					?.calls()
					.map((call) => call.fullUrl),
			).toEqual(Array(2).fill(HOST + pathOf("working-app")));
		});
	});
});
