/**
 * A bring-in's bracketed read of one app, over CommCare HQ's own answers
 * (`proof/hq-reads/reading/` and `publish/`), or such an answer with one key
 * changed.
 *
 * An app saved mid-read accepted, a remote app reported as gone, a build
 * brought in as an app, a permission problem reported as lost membership, a
 * throttled request spent on an edge's refusal, a deadline shared across the
 * reads, a read that outlives a closed tab, and real ids paired to the wrong
 * forms are what these cases would catch.
 */

import type { MockAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedHqAnswer,
	type RetainedReadingRead,
	replyRetained,
	retainedBodyJson,
	retainedBodyText,
	retainedGroupRead,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { log } from "@/lib/logger";
import {
	type HqApplicationModule,
	hqApplicationModules,
	readHqApplication,
} from "../hq/application";
import {
	alignHqForms,
	type HqAlignedModule,
	notSummarizedMenus,
	readHqAppForReading,
} from "../hq/appReading";
import { type HqAppSource, readHqAppSource } from "../hq/appSource";

const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const HOST = "https://india.commcarehq.org";
const DOMAIN = "clinic";

const idOf = (name: RetainedReadingRead) =>
	retainedBodyJson(retainedReadingRead(name)).id as string;
/** The live app every retained answer of the working app names. */
const APP = idOf("application");

const PATHS = {
	application: (appId: string) => `/a/${DOMAIN}/api/application/v1/${appId}/`,
	source: (appId: string) => `/a/${DOMAIN}/apps/source/${appId}/`,
	version: (appId: string) =>
		`/a/${DOMAIN}/apps/view/${appId}/current_version/`,
	list: `/a/${DOMAIN}/apps/api/list_apps/`,
};

const EDGE_403 =
	"<html><head><title>403 Forbidden</title></head><body><center><h1>403 Forbidden</h1></center></body></html>";

afterEach(() => vi.useRealTimers());

function serve(peer: MockAgent, path: string, answer: RetainedHqAnswer): void {
	replyRetained(peer.get(HOST).intercept({ path, method: "GET" }), answer);
}

/** A retained answer with one JSON key changed. */
function withKey(
	answer: RetainedHqAnswer,
	key: string,
	value: unknown,
): RetainedHqAnswer {
	return {
		...answer,
		body: JSON.stringify({ ...retainedBodyJson(answer), [key]: value }),
	};
}

const paths = (peer: MockAgent) =>
	(peer.getCallHistory()?.calls() ?? []).map((call) => call.path);

describe("readHqAppForReading", () => {
	it("reads the app, its source and its counter, with each form's real id beside its source form", async () => {
		await withHttpPeer(async (peer) => {
			serve(peer, PATHS.application(APP), retainedReadingRead("application"));
			serve(peer, PATHS.source(APP), retainedGroupRead("publish/source-live"));
			serve(peer, PATHS.version(APP), retainedReadingRead("current-version"));
			const reading = await readHqAppForReading(CREDS, DOMAIN, APP);
			if (reading.kind !== "read") throw new Error(JSON.stringify(reading));
			const resource = retainedBodyJson(retainedReadingRead("application"));
			expect(reading.version).toBe(resource.version);
			const [menu] = resource.modules as {
				unique_id: string;
				forms: { unique_id: string; xmlns: string }[];
			}[];
			expect(reading.modules).toHaveLength(1);
			const [aligned] = reading.modules;
			if (aligned.kind !== "aligned") throw new Error("Expected aligned");
			expect(aligned.uniqueId).toBe(menu.unique_id);
			expect(aligned.docType).toBe("Module");
			expect(aligned.forms.map((form) => [form.uniqueId, form.xmlns])).toEqual(
				menu.forms.map((form) => [form.unique_id, form.xmlns]),
			);
			/* The source read mints its own ids, so its form is known by position. */
			expect(aligned.forms.map((form) => form.source.xmlns)).toEqual(
				menu.forms.map((form) => form.xmlns),
			);
			expect(paths(peer)).toEqual([
				PATHS.application(APP),
				PATHS.source(APP),
				PATHS.version(APP),
			]);
		});
	});

	it("answers changed when the counter moved between the first read and the last", async () => {
		await withHttpPeer(async (peer) => {
			serve(peer, PATHS.application(APP), retainedReadingRead("application"));
			serve(peer, PATHS.source(APP), retainedGroupRead("publish/source-live"));
			serve(
				peer,
				PATHS.version(APP),
				retainedReadingRead("current-version-after-save"),
			);
			expect(await readHqAppForReading(CREDS, DOMAIN, APP)).toEqual({
				kind: "changed",
			});
		});
	});

	it("reads mirror menus, a report menu and a shadow form, with the sourceless mirror menu not summarized", async () => {
		await withHttpPeer(async (peer) => {
			const resource = retainedReadingRead("application-shadow");
			serve(peer, PATHS.application(APP), resource);
			serve(peer, PATHS.source(APP), retainedReadingRead("source-shadow"));
			serve(
				peer,
				PATHS.version(APP),
				withKey(
					retainedReadingRead("current-version"),
					"currentVersion",
					retainedBodyJson(resource).version,
				),
			);
			const reading = await readHqAppForReading(CREDS, DOMAIN, APP);
			if (reading.kind !== "read") throw new Error(JSON.stringify(reading));
			expect(reading.modules.map((menu) => [menu.kind, menu.docType])).toEqual([
				["aligned", "Module"],
				["aligned", "AdvancedModule"],
				["aligned", "ReportModule"],
				["aligned", "ShadowModule"],
				["not-summarized", "ShadowModule"],
			]);
			expect(notSummarizedMenus(reading.modules)).toEqual({ kind: "none" });
			/* A menu HQ's summary is not expected to hold is no finding, so its message is not logged. */
			expect(log.error).not.toHaveBeenCalled();
		});
	});

	it("reads an app one of whose menus HQ could not summarize, naming that menu and logging none of HQ's text", async () => {
		const resource = retainedReadingRead("application-error-module");
		const resourceBody = retainedBodyJson(resource);
		const [errored, whole] = resourceBody.modules as {
			error?: string;
			unique_id?: string;
			forms?: { xmlns: string }[];
		}[];
		/* No retained source holds this app after the menu was added, so the
		 * live source gains the resource's second menu: its id, and one form
		 * with its `xmlns`. */
		const live = retainedGroupRead("publish/source-live");
		const body = structuredClone(retainedBodyJson(live));
		const [first] = body.modules as Record<string, unknown>[];
		const [form] = first.forms as Record<string, unknown>[];
		(body.modules as Record<string, unknown>[]).push({
			...first,
			unique_id: whole.unique_id,
			forms: [
				{
					...form,
					unique_id: "added-in-hq-form",
					xmlns: whole.forms?.[0].xmlns,
				},
			],
		});
		await withHttpPeer(async (peer) => {
			serve(peer, PATHS.application(APP), resource);
			serve(peer, PATHS.source(APP), { ...live, body: JSON.stringify(body) });
			serve(
				peer,
				PATHS.version(APP),
				retainedReadingRead("current-version-after-save"),
			);
			const reading = await readHqAppForReading(CREDS, DOMAIN, APP);
			if (reading.kind !== "read") throw new Error(JSON.stringify(reading));
			expect(reading.modules.map((menu) => [menu.kind, menu.uniqueId])).toEqual(
				[
					["not-summarized", first.unique_id],
					["aligned", whole.unique_id],
				],
			);
			expect(notSummarizedMenus(reading.modules)).toEqual({
				kind: "menus",
				indexes: [0],
			});
			const message = errored.error ?? "";
			expect(log.error).toHaveBeenCalledWith(
				"[commcare] application module not summarized",
				undefined,
				{
					domain: DOMAIN,
					request: "application",
					appId: APP,
					position: 0,
					docType: "Module",
					opens: "error-in-form",
					length: message.length,
				},
			);
			/* HQ's text quotes the app: the form's name and the choice's label
			 * it names. No log line holds them, nor the app's or a menu's name. */
			const quoted = [
				/Error in form "([^"]*)"/.exec(message)?.[1]?.trim(),
				/\(([^)]*)\)/.exec(message)?.[1],
				resourceBody.name as string,
				(whole as { name?: { en?: string } }).name?.en,
			];
			expect(
				quoted.every((text) => typeof text === "string" && text !== ""),
			).toBe(true);
			const logged = JSON.stringify([
				vi.mocked(log.error).mock.calls,
				vi.mocked(log.warn).mock.calls,
			]);
			expect(logged).not.toContain(message);
			for (const text of quoted) expect(logged).not.toContain(text);
			expect(JSON.stringify(reading.modules)).not.toContain(message);
		});
	});

	it("answers linked for an app the source serves as a linked app", async () => {
		const linked = idOf("application-linked");
		await withHttpPeer(async (peer) => {
			serve(
				peer,
				PATHS.application(linked),
				retainedReadingRead("application-linked"),
			);
			serve(
				peer,
				PATHS.source(linked),
				retainedGroupRead("publish/source-linked"),
			);
			expect(await readHqAppForReading(CREDS, DOMAIN, linked)).toEqual({
				kind: "linked",
			});
			expect(paths(peer)).toEqual([
				PATHS.application(linked),
				PATHS.source(linked),
			]);
		});
	});

	it("answers remote for an app the list holds and the resource answers 404 for", async () => {
		const listed = retainedBodyJson(retainedReadingRead("list-apps"))
			.applications as { app_id: string; name: string }[];
		const remote = listed.find((row) => row.name === "Remote app")?.app_id;
		if (remote === undefined) throw new Error("The list holds no remote app");
		await withHttpPeer(async (peer) => {
			serve(
				peer,
				PATHS.application(remote),
				retainedReadingRead("application-remote"),
			);
			serve(peer, PATHS.list, retainedReadingRead("list-apps"));
			expect(await readHqAppForReading(CREDS, DOMAIN, remote)).toEqual({
				kind: "remote",
			});
			expect(paths(peer)).toEqual([PATHS.application(remote), PATHS.list]);
		});
	});

	const MISSING = "0123456789abcdef0123456789abcdef";

	it.each([
		[
			"deleted",
			"application-deleted",
			retainedGroupRead("publish/source-deleted"),
		],
		[
			"gone",
			"application-deleted",
			retainedGroupRead("publish/source-missing"),
		],
		[
			"gone",
			"application-other-space",
			retainedReadingRead("source-other-space"),
		],
		["gone", "application-remote", retainedReadingRead("source-remote")],
		/* A deleted document that holds a build date may be a build, which is
		 * no app to restore; HQ's source holds no `copy_of` to tell. */
		[
			"gone",
			"application-deleted",
			withKey(
				retainedGroupRead("publish/source-deleted"),
				"built_on",
				"2026-10-05T10:02:19.000000Z",
			),
		],
	] as const)(
		"answers %s where the resource answers 404, the list does not hold the id, and the source read gives %s's answer",
		async (kind, resource, source) => {
			await withHttpPeer(async (peer) => {
				serve(peer, PATHS.application(MISSING), retainedReadingRead(resource));
				serve(peer, PATHS.list, retainedReadingRead("list-apps"));
				serve(peer, PATHS.source(MISSING), source);
				expect(await readHqAppForReading(CREDS, DOMAIN, MISSING)).toEqual({
					kind,
				});
				expect(paths(peer)).toEqual([
					PATHS.application(MISSING),
					PATHS.list,
					PATHS.source(MISSING),
				]);
			});
		},
	);

	it("answers gone for a build's id, and asks nothing more", async () => {
		const build = idOf("application-build");
		await withHttpPeer(async (peer) => {
			serve(
				peer,
				PATHS.application(build),
				retainedReadingRead("application-build"),
			);
			expect(await readHqAppForReading(CREDS, DOMAIN, build)).toEqual({
				kind: "gone",
			});
			expect(paths(peer)).toEqual([PATHS.application(build)]);
		});
	});

	it("reads HQ's 403 as a permission where the list answers, and as lost membership where it refuses", async () => {
		await withHttpPeer(async (peer) => {
			const forbidden = retainedReadingRead("application-no-permission");
			serve(peer, PATHS.application(APP), forbidden);
			serve(peer, PATHS.list, retainedReadingRead("list-apps"));
			expect(await readHqAppForReading(CREDS, DOMAIN, APP)).toEqual({
				kind: "failed",
				failure: {
					kind: "permission",
					request: "application",
					status: 403,
					permission: "access-apis",
				},
			});
			serve(peer, PATHS.application(APP), forbidden);
			serve(peer, PATHS.list, forbidden);
			expect(await readHqAppForReading(CREDS, DOMAIN, APP)).toEqual({
				kind: "failed",
				failure: { kind: "not-a-member", request: "application", status: 403 },
			});
		});
	});

	it("reads an edge's 403 as the gateway's, and spends no list request on it", async () => {
		await withHttpPeer(async (peer) => {
			peer
				.get(HOST)
				.intercept({ path: PATHS.application(APP), method: "GET" })
				.reply(403, EDGE_403, { headers: { "Content-Type": "text/html" } });
			expect(await readHqAppForReading(CREDS, DOMAIN, APP)).toEqual({
				kind: "failed",
				failure: {
					kind: "gateway-refused",
					request: "application",
					status: 403,
				},
			});
			expect(paths(peer)).toEqual([PATHS.application(APP)]);
		});
	});

	it("reads the plan sentence as the plan where the list answers, and as lost membership where it refuses", async () => {
		/* A project space that is gone answers the plan sentence too: its
		 * default plan has no API access, and the plan is checked first. */
		await withHttpPeer(async (peer) => {
			const plan = retainedReadingRead("application-no-api-access");
			serve(peer, PATHS.application(APP), plan);
			serve(peer, PATHS.list, retainedReadingRead("list-apps"));
			expect(await readHqAppForReading(CREDS, DOMAIN, APP)).toEqual({
				kind: "failed",
				failure: {
					kind: "plan-lacks-api-access",
					request: "application",
					status: 401,
				},
			});
			serve(peer, PATHS.application(APP), plan);
			serve(peer, PATHS.list, retainedReadingRead("application-no-permission"));
			expect(await readHqAppForReading(CREDS, DOMAIN, APP)).toEqual({
				kind: "failed",
				failure: { kind: "not-a-member", request: "application", status: 401 },
			});
			expect(paths(peer)).toEqual([
				PATHS.application(APP),
				PATHS.list,
				PATHS.application(APP),
				PATHS.list,
			]);
		});
	});

	it("reads an app body past the bring-in's bound as its own kind", async () => {
		await withHttpPeer(async (peer) => {
			const live = retainedReadingRead("application");
			serve(
				peer,
				PATHS.application(APP),
				withKey(live, "padding", "x".repeat(16 * 1024 * 1024)),
			);
			expect(await readHqAppForReading(CREDS, DOMAIN, APP)).toEqual({
				kind: "failed",
				failure: { kind: "too-large", request: "application", status: 502 },
			});
		});
	});

	it("gives the resource and the source sixty seconds each and the counter its own thirty", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await withHttpPeer(async (peer) => {
			const resource = held(peer, PATHS.application(APP), "application");
			const source = held(peer, PATHS.source(APP), "source");
			const counter = held(peer, PATHS.version(APP), "counter");
			let settled = false;
			const pending = readHqAppForReading(CREDS, DOMAIN, APP).finally(() => {
				settled = true;
			});
			try {
				await resource.reached;
				await vi.advanceTimersByTimeAsync(45_000);
				resource.release();
				await source.reached;
				await vi.advanceTimersByTimeAsync(45_000);
				source.release();
				await counter.reached;
				await vi.advanceTimersByTimeAsync(29_999);
				expect(settled).toBe(false);
				await vi.advanceTimersByTimeAsync(1);
				expect(await pending).toEqual({
					kind: "failed",
					failure: { kind: "timed-out", request: "app-version", status: 503 },
				});
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				resource.release();
				source.release();
				counter.release();
				await pending;
			}
		});
	});

	it("stops at the source read when cancel aborts it, and sends no counter read", async () => {
		await withHttpPeer(async (peer) => {
			serve(peer, PATHS.application(APP), retainedReadingRead("application"));
			const source = held(peer, PATHS.source(APP), "source");
			const cancel = new AbortController();
			const pending = readHqAppForReading(CREDS, DOMAIN, APP, {
				cancel: cancel.signal,
			});
			try {
				await source.reached;
				cancel.abort();
				expect(await pending).toEqual({
					kind: "failed",
					failure: {
						kind: "hq-unavailable",
						request: "app-source",
						status: 503,
					},
				});
				expect(paths(peer)).toEqual([
					PATHS.application(APP),
					PATHS.source(APP),
				]);
				expect(log.warn).not.toHaveBeenCalled();
			} finally {
				source.release();
				await pending;
			}
		});
	});
});

/** A peer that holds a retained answer until the test releases it. */
function held(
	peer: MockAgent,
	path: string,
	which: "application" | "source" | "counter",
) {
	const answer =
		which === "application"
			? retainedReadingRead("application")
			: which === "source"
				? retainedGroupRead("publish/source-live")
				: retainedReadingRead("current-version");
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	peer
		.get(HOST)
		.intercept({ path, method: "GET" })
		.reply(async () => {
			reached.resolve();
			await release.promise;
			return {
				statusCode: answer.status,
				data: retainedBodyText(answer),
				responseOptions: { headers: { ...answer.headers } },
			};
		});
	return { reached: reached.promise, release: () => release.resolve() };
}

/** The production readers' typing of a retained resource answer and a retained source. */
async function readPair(
	resource: RetainedHqAnswer,
	source: RetainedHqAnswer,
): Promise<{ source: HqAppSource; modules: readonly HqApplicationModule[] }> {
	return withHttpPeer(async (peer) => {
		serve(peer, PATHS.application(APP), resource);
		serve(peer, PATHS.source(APP), source);
		const application = await readHqApplication(CREDS, DOMAIN, APP);
		if ("success" in application) throw new Error("application refused");
		const modules = hqApplicationModules(application);
		if ("malformedAt" in modules) throw new Error(modules.malformedAt);
		const read = await readHqAppSource(CREDS, DOMAIN, APP, { admit: "any" });
		if ("success" in read || read.kind !== "source")
			throw new Error("source refused");
		return { source: read.source, modules };
	});
}

const livePair = () =>
	readPair(
		retainedReadingRead("application"),
		retainedGroupRead("publish/source-live"),
	);
const shadowPair = () =>
	readPair(
		retainedReadingRead("application-shadow"),
		retainedReadingRead("source-shadow"),
	);

function summarized(module: HqApplicationModule) {
	if (module.kind !== "summarized") throw new Error("Expected a summary");
	return module;
}

/** `modules` with entry `i` replaced. */
function replaced(
	modules: readonly HqApplicationModule[],
	i: number,
	entry: HqApplicationModule,
): HqApplicationModule[] {
	return modules.map((module, index) => (index === i ? entry : module));
}

/** `source` with menu `i` changed. */
function withMenu(
	source: HqAppSource,
	i: number,
	change: (
		menu: HqAppSource["modules"][number],
	) => HqAppSource["modules"][number],
): HqAppSource {
	return {
		...source,
		modules: source.modules.map((menu, index) =>
			index === i ? change(menu) : menu,
		),
	};
}

describe("alignHqForms", () => {
	it("refuses a module count, a module id, a form count and an xmlns that differ, each at its place", async () => {
		const { source, modules } = await livePair();
		const menu = summarized(modules[0]);
		expect(alignHqForms(source, [...modules, menu])).toEqual({
			kind: "misaligned",
			at: "modules",
		});
		expect(
			alignHqForms(source, [{ ...menu, uniqueId: "someone-else" }]),
		).toEqual({ kind: "misaligned", at: "modules[0].unique_id" });
		expect(
			alignHqForms(source, [{ ...menu, forms: menu.forms.slice(1) }]),
		).toEqual({ kind: "misaligned", at: "modules[0].forms" });
		expect(
			alignHqForms(source, [
				{
					...menu,
					forms: [
						menu.forms[0],
						{ ...menu.forms[1], xmlns: "http://elsewhere" },
					],
				},
			]),
		).toEqual({ kind: "misaligned", at: "modules[0].forms[1].xmlns" });
		/* A null from the resource beside a string from the source disagrees. */
		expect(alignHqForms(source, [{ ...menu, uniqueId: null }])).toEqual({
			kind: "misaligned",
			at: "modules[0].unique_id",
		});
	});

	it("aligns a shadow form by its parent's xmlns", async () => {
		const { source, modules } = await shadowPair();
		const alignment = alignHqForms(source, modules);
		if (alignment.kind !== "aligned") throw new Error(alignment.at);
		const advanced = alignment.modules[1];
		if (advanced.kind !== "aligned") throw new Error("Expected aligned");
		expect(advanced.forms[2].source.xmlns).toBeNull();
		expect(advanced.forms[2].source.shadowParentReadId).toBe(
			advanced.forms[0].source.readUniqueId,
		);
		expect(advanced.forms[2].xmlns).toBe(advanced.forms[0].xmlns);
		expect(advanced.forms[2].uniqueId).toBe(
			summarized(modules[1]).forms[2].uniqueId,
		);
	});

	it("aligns a shadow form with no parent null with null, and refuses a null on one side alone", async () => {
		const { source, modules } = await shadowPair();
		const orphaned = withMenu(source, 1, (menu) => ({
			...menu,
			forms: menu.forms.map((form, j) =>
				j === 2 ? { ...form, shadowParentReadId: null } : form,
			),
		}));
		const advanced = summarized(modules[1]);
		const parentGone = replaced(modules, 1, {
			...advanced,
			forms: advanced.forms.map((form, j) =>
				j === 2 ? { ...form, xmlns: null } : form,
			),
		});
		const alignment = alignHqForms(orphaned, parentGone);
		if (alignment.kind !== "aligned") throw new Error(alignment.at);
		const menu = alignment.modules[1];
		if (menu.kind !== "aligned") throw new Error("Expected aligned");
		expect(menu.forms[2].xmlns).toBeNull();
		expect(alignHqForms(orphaned, modules)).toEqual({
			kind: "misaligned",
			at: "modules[1].forms[2].xmlns",
		});
		expect(alignHqForms(source, parentGone)).toEqual({
			kind: "misaligned",
			at: "modules[1].forms[2].xmlns",
		});
	});

	it("gives an error entry as not summarized, with the source's menu id and doc type", async () => {
		const { source, modules } = await livePair();
		const shape = { opens: "other", length: 9 } as const;
		const alignment = alignHqForms(
			source,
			replaced(modules, 0, { kind: "error", shape }),
		);
		expect(alignment).toEqual({
			kind: "aligned",
			modules: [
				{
					kind: "not-summarized",
					uniqueId: source.modules[0].uniqueId,
					docType: "Module",
					shape,
				},
			],
		});
	});

	it("aligns a menu that stores no id by position, whatever the resource reports for it", async () => {
		const { source, modules } = await livePair();
		const noId = withMenu(source, 0, (menu) => ({ ...menu, uniqueId: null }));
		const menu = summarized(modules[0]);
		for (const reported of [null, menu.uniqueId]) {
			const alignment = alignHqForms(noId, [{ ...menu, uniqueId: reported }]);
			if (alignment.kind !== "aligned") throw new Error(alignment.at);
			expect(alignment.modules[0]).toMatchObject({
				kind: "aligned",
				uniqueId: null,
			});
		}
	});
});

describe("notSummarizedMenus", () => {
	async function shadowAlignedWith(
		errors: readonly number[],
	): Promise<readonly HqAlignedModule[]> {
		const { source, modules } = await shadowPair();
		const changed = modules.map(
			(module, i): HqApplicationModule =>
				errors.includes(i)
					? { kind: "error", shape: { opens: "other", length: 4 } }
					: module,
		);
		const alignment = alignHqForms(source, changed);
		if (alignment.kind !== "aligned") throw new Error(alignment.at);
		return alignment.modules;
	}

	it("is none for a whole summary", async () => {
		const { source, modules } = await livePair();
		const alignment = alignHqForms(source, modules);
		if (alignment.kind !== "aligned") throw new Error(alignment.at);
		expect(notSummarizedMenus(alignment.modules)).toEqual({ kind: "none" });
	});

	it("names one basic menu's position when it alone is an error", async () => {
		expect(notSummarizedMenus(await shadowAlignedWith([0]))).toEqual({
			kind: "menus",
			indexes: [0],
		});
	});

	it("is the app when every basic and advanced menu of two or more is an error", async () => {
		expect(notSummarizedMenus(await shadowAlignedWith([0, 1]))).toEqual({
			kind: "app",
		});
	});

	it("names an error at a mirror menu or a report menu nowhere", async () => {
		expect(notSummarizedMenus(await shadowAlignedWith([2, 3]))).toEqual({
			kind: "none",
		});
		expect(notSummarizedMenus(await shadowAlignedWith([1, 2]))).toEqual({
			kind: "menus",
			indexes: [1],
		});
	});
});
