/**
 * `FORM_TEXT_READ_AS_INSTANCE` at the commit gate: a form's name in the app's
 * default language and a Connect block's name and description are plain text
 * in the form's source, where CommCare HQ's build reads `instance('…')` as an
 * instance read, so the gate refuses the text and offers a space before the
 * bracket.
 *
 * Every edit runs through the production gate (`mutationCommitVerdict`), and
 * each one the builder's scoped gate takes is also run under its scope
 * (`incrementalValidationScope`), so a scope that leaves the form out shows
 * as a scoped verdict that differs from the whole-document one. Plausible
 * failures: a site the rule does not read, the default language's translated
 * name slipping past while the source name is read, a name in another
 * language refused, a finding naming the wrong site.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	evaluatePreparedMutationCandidate,
	mutationCommitVerdict,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { incrementalValidationScope } from "@/lib/doc/incrementalValidationScope";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	type BlueprintDoc,
	type ConnectConfig,
	makeTranslationUnitId,
	proseText,
} from "@/lib/domain";
import { snapshotTranslationUnits } from "@/lib/domain/translationUnits";
import type { ValidationError } from "../errors";
import { runValidation } from "../runner";

const FORM = testUuid("instance-text-form");
const MODULE = testUuid("instance-text-module");
const READ = "instance('casedb')";
const OFFERED = "instance ('casedb')";

function surveyDoc(name = "Practice"): BlueprintDoc {
	return buildDoc({
		appName: "Instance text",
		modules: [
			{
				uuid: "instance-text-module",
				name: "Survey",
				forms: [
					{
						uuid: "instance-text-form",
						name,
						type: "survey",
						fields: [{ kind: "text", id: "notes", label: proseText("Notes") }],
					},
				],
			},
		],
	});
}

function connectDoc(
	connectType: "learn" | "deliver",
	connect: ConnectConfig,
): BlueprintDoc {
	return buildDoc({
		appName: "Instance text",
		connectType,
		modules: [
			{
				uuid: "instance-text-module",
				name: "Training",
				forms: [
					{
						uuid: "instance-text-form",
						name: "Lesson",
						type: "survey",
						connect,
						fields: [{ kind: "text", id: "notes", label: proseText("Notes") }],
					},
				],
			},
		],
	});
}

const learn = (name: string, description: string): ConnectConfig => ({
	learn_module: { id: "lesson_one", name, description, time_estimate: 5 },
});

const instanceFindings = (findings: readonly ValidationError[]) =>
	findings.filter((finding) => finding.code === "FORM_TEXT_READ_AS_INSTANCE");

/**
 * The gate's findings for one batch, after holding the scoped verdict to the
 * whole-document one wherever the batch takes a scope.
 */
function gateFindings(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): ValidationError[] {
	const whole = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	const prepared = prepareMutationCandidate(doc, admitMutationBatch(mutations));
	const scope = incrementalValidationScope(doc, mutations, prepared.nextDoc);
	if (scope !== undefined) {
		const scoped = evaluatePreparedMutationCandidate(
			prepared,
			LOOKUP_CONTEXT_UNAVAILABLE,
			{ validationScope: scope },
		);
		expect(scoped.ok ? [] : instanceFindings(scoped.findings)).toEqual(
			whole.ok ? [] : instanceFindings(whole.findings),
		);
	}
	return whole.ok ? [] : whole.findings;
}

function expectAdmitted(doc: BlueprintDoc): void {
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
}

const formNameUnit = (doc: BlueprintDoc) => {
	const unit = snapshotTranslationUnits(doc).get(
		makeTranslationUnitId("form", FORM, "name"),
	);
	if (unit === undefined) throw new Error("The form's name has no unit.");
	return unit;
};

/** The doc with Spanish added, the form's Spanish name set to `spanish`. */
function withSpanishName(doc: BlueprintDoc, spanish: string): Mutation[] {
	return [
		{ kind: "addLanguage", language: { language: "spa" }, wireCode: "es" },
		{
			kind: "setTranslation",
			language: "spa",
			unitId: formNameUnit(doc).id,
			entry: {
				value: spanish,
				sourceFingerprint: formNameUnit(doc).sourceFingerprint,
				origin: "human",
				review: "reviewed",
				translatedFrom: "eng",
			},
		},
	];
}

function commit(doc: BlueprintDoc, mutations: readonly Mutation[]) {
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!verdict.ok)
		throw new Error(
			`The fixture's edit was refused: ${verdict.findings.map((f) => f.message).join(" ")}`,
		);
	return verdict.nextDoc;
}

describe("FORM_TEXT_READ_AS_INSTANCE", () => {
	it("refuses a form renamed to hold the text, at the form, naming the site and the match", () => {
		const doc = surveyDoc();
		expectAdmitted(doc);
		const findings = gateFindings(doc, [
			{ kind: "renameForm", uuid: FORM, newId: `${READ} practice` },
		]);
		expect(findings).toHaveLength(1);
		const [finding] = findings;
		expect(finding.code).toBe("FORM_TEXT_READ_AS_INSTANCE");
		expect(finding.scope).toBe("form");
		expect(finding.location).toEqual({
			moduleUuid: MODULE,
			moduleName: "Survey",
			formUuid: FORM,
			formName: `${READ} practice`,
		});
		expect(finding.details).toEqual({ site: "form-name", match: READ });
		expect(finding.message).toBe(
			`The name of the form "${READ} practice" in the app's default language holds ${READ}. CommCare HQ reads instance( followed by a quoted name and a closing bracket as a data source wherever it appears in a form, and a form's name is written there as plain text, so CommCare HQ would add that data source to the form or stop its build. A space before the bracket keeps it as text: instance ('...').`,
		);
		expect(userFacingError(finding)).toBe(
			`The name of "${READ} practice" holds ${READ}, which CommCare HQ reads as a data source and not as text. A space before the bracket keeps it as text.`,
		);
	});

	it("admits the spelling it offers, a space before the bracket", () => {
		expect(
			gateFindings(surveyDoc(), [
				{ kind: "renameForm", uuid: FORM, newId: `${OFFERED} practice` },
			]),
		).toEqual([]);
	});

	it("cuts a long match to its first 40 characters", () => {
		const long = `instance('${"a".repeat(60)}')`;
		const [finding] = gateFindings(surveyDoc(), [
			{ kind: "renameForm", uuid: FORM, newId: long },
		]);
		expect(finding.details?.match).toBe(long.slice(0, 40));
	});

	it("refuses a learn module's description edited through updateForm, and admits it with the space", () => {
		const doc = connectDoc("learn", learn("Lesson one", "Shows the case list"));
		expectAdmitted(doc);
		const findings = gateFindings(doc, [
			{
				kind: "updateForm",
				uuid: FORM,
				patch: {
					connect: learn("Lesson one", `Shows how ${READ} works`),
				},
			},
		]);
		expect(findings.map((f) => [f.code, f.details])).toEqual([
			[
				"FORM_TEXT_READ_AS_INSTANCE",
				{ site: "learn-module-description", match: READ },
			],
		]);
		expect(findings[0].message).toBe(
			`The learn module's description in "Lesson" holds ${READ}. CommCare HQ reads instance( followed by a quoted name and a closing bracket as a data source wherever it appears in a form, and CommCare Connect reads this text exactly as the form holds it, so CommCare HQ would add that data source to the form or stop its build. A space before the bracket keeps it as text: instance ('...').`,
		);
		expect(userFacingError(findings[0])).toBe(
			`The learn module's description in "Lesson" holds ${READ}, which CommCare HQ reads as a data source and not as text. A space before the bracket keeps it as text.`,
		);
		expect(
			gateFindings(doc, [
				{
					kind: "updateForm",
					uuid: FORM,
					patch: {
						connect: learn("Lesson one", `Shows how ${OFFERED} works`),
					},
				},
			]),
		).toEqual([]);
	});

	it("reads every Connect text the form's source holds, each at its own site", () => {
		const learnDoc = connectDoc(
			"learn",
			learn("instance('a')", 'instance("item-list:villages")'),
		);
		expect(
			instanceFindings(runValidation(learnDoc, LOOKUP_CONTEXT_UNAVAILABLE)).map(
				(f) => f.details,
			),
		).toEqual([
			{ site: "learn-module-name", match: "instance('a')" },
			{
				site: "learn-module-description",
				match: 'instance("item-list:villages")',
			},
		]);
		const deliverDoc = connectDoc("deliver", {
			deliver_unit: { id: "visit_unit", name: "Visit instance( 'b' )" },
		});
		expect(
			instanceFindings(
				runValidation(deliverDoc, LOOKUP_CONTEXT_UNAVAILABLE),
			).map((f) => f.details),
		).toEqual([{ site: "deliver-unit-name", match: "instance( 'b' )" }]);
		const taskDoc = connectDoc("deliver", {
			task: {
				id: "follow_up",
				name: "Read instance('c')",
				description: "then instance('d')",
			},
		});
		expect(
			instanceFindings(runValidation(taskDoc, LOOKUP_CONTEXT_UNAVAILABLE)).map(
				(f) => f.details,
			),
		).toEqual([
			{ site: "task-name", match: "instance('c')" },
			{ site: "task-description", match: "instance('d')" },
		]);
	});

	it("admits the text in a label, which the form writes so CommCare HQ reads it as text", () => {
		const doc = buildDoc({
			appName: "Instance text",
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Practice",
							type: "survey",
							fields: [{ kind: "text", id: "notes", label: proseText(READ) }],
						},
					],
				},
			],
		});
		expectAdmitted(doc);
	});

	it("refuses the default language's translated name, and admits the text in another language's name", () => {
		const doc = surveyDoc();
		const other = gateFindings(doc, withSpanishName(doc, `${READ} práctica`));
		expect(other).toEqual([]);

		const spanish = commit(doc, withSpanishName(doc, `${READ} práctica`));
		const findings = gateFindings(spanish, [
			{ kind: "setDefaultLanguage", code: "spa" },
		]);
		expect(findings.map((f) => [f.code, f.details])).toEqual([
			["FORM_TEXT_READ_AS_INSTANCE", { site: "form-name", match: READ }],
		]);
		/* The location names the form by its source name, and the sentence
		 * shows the match, so it reads true for the translated name. */
		expect(findings[0].location.formName).toBe("Practice");
	});

	it("refuses a translation written into the language that is already the default", () => {
		const doc = surveyDoc();
		const spanish = commit(doc, [
			...withSpanishName(doc, "Práctica"),
			{ kind: "setDefaultLanguage", code: "spa" },
		]);
		const findings = gateFindings(spanish, [
			{
				kind: "setTranslation",
				language: "spa",
				unitId: formNameUnit(spanish).id,
				entry: {
					value: `${READ} práctica`,
					sourceFingerprint: formNameUnit(spanish).sourceFingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: "eng",
				},
			},
		]);
		expect(findings.map((f) => [f.code, f.details])).toEqual([
			["FORM_TEXT_READ_AS_INSTANCE", { site: "form-name", match: READ }],
		]);
	});
});
