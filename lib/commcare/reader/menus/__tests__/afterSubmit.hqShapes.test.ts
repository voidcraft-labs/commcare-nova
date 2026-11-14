/**
 * After-submit shapes CommCare HQ's form settings page stores that Nova's
 * emitter does not: the otherwise written as a last link, a fallback beside
 * links that always run, a guard-shaped conjunct of the author's, a link that
 * carries a case with no guard, and the workflow word `default`.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { buildShape } from "../../../__tests__/formLinkDocArbitrary";
import { expandDoc } from "../../../expander";
import {
	readContext,
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "../../__tests__/readerInput";
import { STAGES } from "../../index";
import { bindExpressions } from "../../provisional";
import { defaultPostSubmitAbsent } from "../afterSubmit";
import {
	type AppJson,
	codesOf,
	formNamed,
	type JsonObject,
	readMenusOf,
} from "./menuReading";

/** The stored links of the generator's source form. */
function links(app: AppJson): JsonObject[] {
	return app.modules[0]?.forms[0]?.form_links as JsonObject[];
}

function rewrites(reading: Awaited<ReturnType<typeof readMenusOf>>): string[] {
	return reading.outcome.kind === "read"
		? reading.outcome.draft.facts.sameStateRewrites.map((one) => one.register)
		: [];
}

/** The texts registered for the expression stage, read up to the binding. */
async function registeredTexts(
	doc: BlueprintDoc,
	edit: (app: AppJson) => void,
): Promise<string[]> {
	const emitted = expandDoc(doc);
	const app = JSON.parse(
		JSON.stringify({
			...retainedSourceBody("shell/app-source"),
			modules: emitted.modules,
			_attachments: emitted._attachments,
		}),
	) as AppJson;
	edit(app);
	const ctx = readContext({
		...readerInput(await sourceFromBody(app)),
		recordDialect: () => undefined,
	});
	for (const stage of STAGES) {
		if (stage === bindExpressions) break;
		stage(ctx);
	}
	return ctx.pending
		.list()
		.filter(
			(one) => "slot" in one.ref && one.ref.slot === "form_link_condition",
		)
		.map((one) => one.text);
}

describe("the otherwise written as a last link", () => {
	it("reads `[L1: c, L2: not(c)]` as destination L1 and otherwise L2", async () => {
		const doc = buildShape([{ flag: 0, toMenu: true }], { kind: "none" });
		const reading = await readMenusOf(doc, (app) => {
			const [first] = links(app);
			links(app).push({ ...first, xpath: `not(${first?.xpath as string})` });
		});
		expect(codesOf(reading)).toEqual([]);
		const check = formNamed(reading.doc as BlueprintDoc, "Check");
		expect(check.formLinks).toHaveLength(1);
		expect(check.otherwise).toEqual(
			expect.objectContaining({
				kind: "link",
				target: { type: "module", moduleUuid: expect.any(String) },
			}),
		);
	});

	it("reads a fallback beside links that always run as nothing", async () => {
		const doc = buildShape([{ toMenu: true }], { kind: "none" });
		const reading = await readMenusOf(doc, (app) => {
			(app.modules[0]?.forms[0] as JsonObject).post_form_workflow_fallback =
				"module";
		});
		expect(codesOf(reading)).toEqual([]);
		expect(
			formNamed(reading.doc as BlueprintDoc, "Check").otherwise,
		).toBeUndefined();
	});
});

describe("held-case guards", () => {
	it("never registers a guard Nova writes, and keeps an author's conjunct of the guard's shape", async () => {
		const doc = buildShape([{ flag: 0, carry: "c0", toMenu: false }], {
			kind: "none",
		});
		const authored =
			"count(instance('casedb')/casedb/case[@case_id = 'c9' and @case_type = 'frog']) > 0";
		const plain = await registeredTexts(doc, () => {});
		expect(plain).toHaveLength(1);
		expect(plain[0]).not.toContain("count(");
		const withAuthored = await registeredTexts(doc, (app) => {
			const [first] = links(app);
			if (first !== undefined) {
				const text = first.xpath as string;
				// The author's conjunct stands ahead of Nova's guard, which stays last.
				const cut = text.lastIndexOf(" and count(");
				first.xpath = `${text.slice(0, cut)} and ${authored}${text.slice(cut)}`;
			}
		});
		expect(withAuthored).toHaveLength(1);
		expect(withAuthored[0]).toContain("'c9'");
		expect(withAuthored[0]).not.toContain("'c0'");
	});

	it("reads a link that carries a case with no guard as its condition alone, and records the guard added", async () => {
		const doc = buildShape([{ carry: "c0", toMenu: false }], { kind: "none" });
		const reading = await readMenusOf(doc, (app) => {
			const [first] = links(app);
			if (first !== undefined) first.xpath = "";
		});
		expect(codesOf(reading)).toEqual([]);
		const [link] =
			formNamed(reading.doc as BlueprintDoc, "Check").formLinks ?? [];
		expect(link?.condition).toBeUndefined();
		expect(link?.datums).toHaveLength(1);
		expect(rewrites(reading)).toContain("link-held-case-guards-added");
	});
});

describe("the workflow word `default`", () => {
	const app = () =>
		buildDoc({
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "name",
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
							],
						},
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "notes",
									caseWrite: { caseType: "patient", property: "notes" },
								}),
							],
						},
					],
				},
			],
		});

	it("stores app_home on a follow-up and nothing on a registration", async () => {
		const reading = await readMenusOf(app(), (json) => {
			for (const form of json.modules[0]?.forms ?? [])
				form.post_form_workflow = "default";
		});
		expect(codesOf(reading)).toEqual([]);
		const doc = reading.doc as BlueprintDoc;
		expect(formNamed(doc, "Visit").postSubmit).toBe("app_home");
		expect(formNamed(doc, "Register").postSubmit).toBeUndefined();
	});

	it("is absent where it is the form's own default (default-post-submit-is-absent)", () => {
		const doc = app();
		const visit = formNamed(doc, "Visit");
		const stored = {
			...doc,
			forms: {
				...doc.forms,
				[visit.uuid]: { ...visit, postSubmit: "previous" as const },
			},
		};
		const canonical = defaultPostSubmitAbsent(stored);
		expect(formNamed(canonical, "Visit").postSubmit).toBeUndefined();
		expect(defaultPostSubmitAbsent(canonical)).toBe(canonical);
	});
});
