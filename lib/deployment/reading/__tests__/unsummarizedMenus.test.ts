/**
 * Which findings a reading gives for the menus CommCare HQ could not
 * summarize, over CommCare HQ's own answers (`proof/hq-reads/reading/`):
 * a whole summary, and the answer whose first menu is an error entry because
 * one of its forms holds a choice with no value.
 *
 * A second finding beside the form's own for one cause (HQ's failure to
 * summarize the menu of a form the reading already refuses), and a menu
 * whose failure is dropped though the reading names no cause of HQ's, are
 * what these cases would catch.
 */

import { describe, expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedHqAnswer,
	replyRetained,
	retainedBodyJson,
	retainedGroupRead,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import {
	hqApplicationModules,
	readHqApplication,
} from "@/lib/commcare/hq/application";
import {
	alignHqForms,
	type HqAlignedModule,
} from "@/lib/commcare/hq/appReading";
import { readHqAppSource } from "@/lib/commcare/hq/appSource";
import type {
	Finding,
	HqPlace,
	ManifestFinding,
} from "@/lib/publish/hqFindings";
import { unsummarizedBeside, unsummarizedFindings } from "../unsummarizedMenus";

const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const HOST = "https://india.commcarehq.org";
const DOMAIN = "clinic";

type Body = Record<string, unknown>;

/** The live app every retained answer of the working app names. */
const APP = retainedBodyJson(retainedReadingRead("application")).id as string;

/** The production readers' typing of a resource answer and a source, aligned. */
async function aligned(resource: RetainedHqAnswer, source: RetainedHqAnswer) {
	return withHttpPeer(async (peer) => {
		replyRetained(
			peer.get(HOST).intercept({
				path: `/a/${DOMAIN}/api/application/v1/${APP}/`,
				method: "GET",
			}),
			resource,
		);
		replyRetained(
			peer.get(HOST).intercept({
				path: `/a/${DOMAIN}/apps/source/${APP}/`,
				method: "GET",
			}),
			source,
		);
		const application = await readHqApplication(CREDS, DOMAIN, APP);
		if ("success" in application) throw new Error("application refused");
		const modules = hqApplicationModules(application);
		if ("malformedAt" in modules) throw new Error(modules.malformedAt);
		const read = await readHqAppSource(CREDS, DOMAIN, APP, { admit: "any" });
		if ("success" in read || read.kind !== "source")
			throw new Error("source refused");
		const alignment = alignHqForms(read.source, modules);
		if (alignment.kind !== "aligned") throw new Error(alignment.at);
		return { source: read.source, modules: alignment.modules };
	});
}

/** HQ's whole summary of the live app, beside its source. */
const whole = () =>
	aligned(
		retainedReadingRead("application"),
		retainedGroupRead("publish/source-live"),
	);

/**
 * HQ's answer whose first menu is an error entry (`Error in form "…": <item> … has no <value>`,
 * as `FormBase.get_questions` wraps the form's `XFormException`), beside the live source with the
 * second menu that answer summarizes.
 */
function errorAtFirstMenu() {
	const resource = retainedReadingRead("application-error-module");
	const resourceBody = retainedBodyJson(resource);
	const [, summarized] = resourceBody.modules as Body[];
	const live = retainedGroupRead("publish/source-live");
	const body = structuredClone(retainedBodyJson(live));
	const [first] = body.modules as Body[];
	const [form] = first.forms as Body[];
	(body.modules as Body[]).push({
		...first,
		unique_id: summarized.unique_id,
		forms: [
			{
				...form,
				unique_id: "added-in-hq-form",
				xmlns: ((summarized.forms as Body[])[0] as Body).xmlns,
			},
		],
	});
	return aligned(
		{ ...resource, body: JSON.stringify({ ...resourceBody, id: APP }) },
		{ ...live, body: JSON.stringify(body) },
	);
}

/** A finding the reader gives at `place` under an entry of the given standing and cause. */
function readerFinding(
	place: HqPlace,
	standing: ManifestFinding["standing"],
	cause?: ManifestFinding["cause"],
): Finding {
	return {
		code: "questions/item-without-value-or-an-itemset-without-label-or-without-both",
		standing,
		...(cause !== undefined && { cause }),
		place,
		subject: "question-choices",
		detail: {},
	};
}

const atForm = (menu: number): HqPlace => ({
	kind: "form",
	menu,
	form: 0,
	menuName: "Patients",
	name: "Visit",
});
const atQuestion = (menu: number): HqPlace => ({
	kind: "question",
	menu,
	form: 0,
	menuName: "Patients",
	formName: "Visit",
	path: "colour",
});

describe("unsummarizedFindings", () => {
	it("gives none for HQ's whole summary", async () => {
		const { source, modules } = await whole();
		expect(unsummarizedFindings(source, modules)).toEqual({
			app: false,
			findings: [],
		});
	});

	it("gives one finding at the menu HQ answered as an error, naming it in the first language", async () => {
		const { source, modules } = await errorAtFirstMenu();
		const { app, findings } = unsummarizedFindings(source, modules);
		expect(app).toBe(false);
		expect(findings.map((finding) => [finding.code, finding.place])).toEqual([
			[
				"menu-unreadable-in-hq",
				{
					kind: "menu",
					menu: 0,
					name: expect.any(String),
				},
			],
		]);
	});

	it("gives the app's one finding where every menu of two or more is an error", async () => {
		const { source, modules } = await errorAtFirstMenu();
		const [first] = modules;
		const both: HqAlignedModule[] = modules.map((menu) =>
			menu.kind === "not-summarized" || first?.kind !== "not-summarized"
				? menu
				: { ...first, uniqueId: menu.uniqueId, docType: menu.docType },
		);
		const unsummarized = unsummarizedFindings(source, both);
		expect(unsummarized.app).toBe(true);
		expect(unsummarized.findings.map((finding) => finding.code)).toEqual([
			"app-unreadable-in-hq",
		]);
		/* The reading's own findings never cover the app's. */
		expect(
			unsummarizedBeside(unsummarized, [
				readerFinding(atForm(0), "fix-in-hq", "hq-refuses"),
			]),
		).toEqual(unsummarized.findings);
	});
});

describe("unsummarizedBeside", () => {
	it("leaves the menu's finding out where the reading names a form of it HQ will not build", async () => {
		const { source, modules } = await errorAtFirstMenu();
		const unsummarized = unsummarizedFindings(source, modules);
		for (const place of [atForm(0), atQuestion(0)])
			for (const cause of ["hq-refuses", "either"] as const)
				expect(
					unsummarizedBeside(unsummarized, [
						readerFinding(place, "fix-in-hq", cause),
					]),
				).toEqual([]);
	});

	it("keeps the menu's finding where the reading names no cause of HQ's at that menu", async () => {
		const { source, modules } = await errorAtFirstMenu();
		const unsummarized = unsummarizedFindings(source, modules);
		const kept: readonly (readonly Finding[])[] = [
			[],
			/* A form of another menu. */
			[readerFinding(atForm(1), "fix-in-hq", "hq-refuses")],
			/* A form that builds and then does not work when the app runs. */
			[readerFinding(atForm(0), "fix-in-hq", "breaks-when-run")],
			/* What Nova does not hold yet, or never will. */
			[readerFinding(atQuestion(0), "not-yet")],
			[readerFinding(atQuestion(0), "never")],
			/* The menu's case list, which HQ's summary does not read. */
			[
				readerFinding(
					{ kind: "case-list", menu: 0, name: "Patients" },
					"fix-in-hq",
					"hq-refuses",
				),
			],
		];
		for (const reading of kept)
			expect(unsummarizedBeside(unsummarized, reading)).toEqual(
				unsummarized.findings,
			);
	});
});
