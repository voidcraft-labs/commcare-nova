import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import {
	addLanguageMutation,
	heldLanguageWireCodes,
} from "@/lib/doc/languageMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import {
	collectTranslationUnits,
	type PersistableDoc,
	type ProseTemplate,
	proseText,
	simpleSearchInputDef,
	type TranslationEntry,
} from "@/lib/domain";
import {
	eq,
	literal,
	prop,
	sessionUser,
	term,
} from "@/lib/domain/expression/builders";
import type { SessionUserRef } from "@/lib/domain/expression/types";
import type { Uuid } from "@/lib/domain/uuid";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	needsWorkerFieldRepair,
	repairUndeclaredWorkerFields,
	UndeclaredWorkerFieldRefusal,
	type UndeclaredWorkerFieldRefusalReason,
	undeclaredWorkerFieldPropertyUuid,
	verifyUndeclaredWorkerFieldRepair,
	workerFieldReadCensus,
} from "../undeclaredWorkerFieldRepair";

const APP_ID = "app-undeclared-worker-fields";
const MODULE = testUuid("worker-fields-module");
const FORM = testUuid("worker-fields-form");
const HIDDEN = testUuid("worker-fields-hidden");
const PROJECT_HIDDEN = testUuid("worker-fields-project");
const QUESTION = testUuid("worker-fields-question");
const SEARCH_INPUT = testUuid("worker-fields-search-input");

const fromRecord = (field: string): SessionUserRef => ({
	kind: "session-user",
	field,
	source: "worker-record",
});

/** A label reading the worker's `district` twice: a worker reference (a
 *  read of the worker's record) and a calculated value reading the session. */
function districtLabel(words: string): ProseTemplate {
	return {
		parts: [
			{ kind: "text", text: `${words}: ` },
			{ kind: "user-ref", property: "district" },
			{ kind: "text", text: " / " },
			{ kind: "value", expression: term(sessionUser("district")) },
		],
	};
}

interface FixtureOptions {
	/** The Spanish translation of the question's label: current, out of
	 *  date, or none. */
	readonly translation?: "current" | "stale";
	/** Extra session reads by name, in a Hidden Value each. */
	readonly extraReads?: readonly string[];
}

/**
 * An app reading the worker's `district` by name, never declared, in every
 * kind of place: from the session in the menu's display condition, a Hidden
 * Value's calculation, the case list's filter, a Search field's starting
 * value and a calculated value in a question's label; from the worker's
 * record in the question's display condition and a worker reference in its
 * label. It also reads `role` in the display condition, and the built-in
 * `commcare_project`, which needs no declaration.
 */
function fixture(options: FixtureOptions = {}): PersistableDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.filter = eq(
		prop("patient", "district"),
		term(sessionUser("district")),
	);
	config.searchInputs = [
		{
			...simpleSearchInputDef(
				SEARCH_INPUT,
				"district",
				"District",
				"text",
				"district",
			),
			default: term(sessionUser("district")),
		},
	];
	const doc = buildDoc({
		appId: APP_ID,
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "district", label: proseText("District") },
				],
			},
		],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				displayCondition: {
					kind: "and",
					clauses: [
						eq(term(sessionUser("district")), literal("north")),
						eq(term(sessionUser("role")), literal("nurse")),
					],
				},
				caseListConfig: config,
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								uuid: HIDDEN,
								kind: "hidden",
								id: "district_copy",
								calculate: term(sessionUser("district")),
							}),
							f({
								uuid: PROJECT_HIDDEN,
								kind: "hidden",
								id: "project_copy",
								calculate: term(sessionUser("commcare_project")),
							}),
							f({
								uuid: QUESTION,
								kind: "text",
								id: "notes",
								label: districtLabel("District"),
								relevant: eq(term(fromRecord("district")), literal("north")),
							}),
							...(options.extraReads ?? []).map((name) =>
								f({
									uuid: testUuid(`worker-fields-extra-${name}`),
									kind: "hidden",
									id: `extra_${name.replaceAll("-", "_")}`,
									calculate: term(sessionUser(name)),
								}),
							),
						],
					},
				],
			},
		],
	});
	if (options.translation === undefined) return toPersistableDoc(doc);
	const withSpanish = produce(doc, (draft) => {
		applyMutations(draft, [
			addLanguageMutation(heldLanguageWireCodes(draft), { language: "spa" }),
		]);
	});
	const unit = collectTranslationUnits(withSpanish).find(
		(candidate) =>
			candidate.owner.kind === "field" &&
			candidate.owner.fieldUuid === QUESTION &&
			candidate.role === "field-label",
	);
	if (unit === undefined) throw new Error("Expected the label's unit.");
	const entry: TranslationEntry = {
		value: districtLabel("Distrito"),
		sourceFingerprint:
			options.translation === "current"
				? unit.sourceFingerprint
				: 'source-v1:prose:{"parts":[]}',
		origin: "human",
		review: "reviewed",
		translatedFrom: "eng",
	};
	return toPersistableDoc(
		produce(withSpanish, (draft) => {
			applyMutations(draft, [
				{ kind: "setTranslation", language: "spa", unitId: unit.id, entry },
			]);
		}),
	);
}

/** Declare `slug` on a saved document without rebinding a read, as an app
 *  saved before the gate holds it. */
function declare(doc: PersistableDoc, uuid: Uuid, slug: string): void {
	doc.userProperties = {
		...doc.userProperties,
		[uuid]: { uuid, slug, label: slug },
	};
	doc.userPropertyOrder = [...(doc.userPropertyOrder ?? []), uuid];
}

function gateCodes(persisted: PersistableDoc): string[] {
	const verdict = mutationCommitVerdict(
		hydratePersistedBlueprint(persisted),
		[],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	return verdict.ok ? [] : verdict.findings.map((finding) => finding.code);
}

/** Every worker read of the document, wherever it is stored: `name:` for a
 *  read by name (with `@record` for the worker's record), `id:` for one by
 *  identity. */
function workerReads(doc: PersistableDoc): string[] {
	const reads: string[] = [];
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		const node = value as Record<string, unknown>;
		const at = node.source === "worker-record" ? "@record" : "";
		if (node.kind === "session-user") reads.push(`name:${node.field}${at}`);
		if (node.kind === "session-user-property")
			reads.push(`id:${node.userPropertyUuid}${at}`);
		if (node.kind === "user-ref") reads.push(`name:${node.property}@record`);
		if (node.kind === "user-property-ref")
			reads.push(`id:${node.userPropertyUuid}@record`);
		for (const child of Object.values(node)) visit(child);
	};
	visit(doc);
	return reads.sort();
}

function refusalOf(run: () => unknown): UndeclaredWorkerFieldRefusal {
	try {
		run();
	} catch (error) {
		if (error instanceof UndeclaredWorkerFieldRefusal) return error;
		throw error;
	}
	throw new Error("Expected a refusal.");
}

function expectRefused(
	run: () => unknown,
	reason: UndeclaredWorkerFieldRefusalReason,
): void {
	const refusal = refusalOf(run);
	expect(refusal.reason).toBe(reason);
	// A refusal names a reason, never the app's content.
	for (const content of ["district", "District", "role", "xml_zone", "zone"])
		expect(refusal.message).not.toContain(content);
}

describe("repairUndeclaredWorkerFields", () => {
	it("declares each undeclared field, rebinds every read in every place, and keeps every export", () => {
		const before = fixture({ translation: "current" });
		expect(workerFieldReadCensus(before)).toEqual({
			undeclared: ["district", "role"],
			declaredReadByName: 0,
		});
		expect(gateCodes(before)).not.toEqual([]);

		const repair = repairUndeclaredWorkerFields(before);
		const district = undeclaredWorkerFieldPropertyUuid(APP_ID, "district");
		const role = undeclaredWorkerFieldPropertyUuid(APP_ID, "role");
		expect(repair.declaredSlugs).toEqual(["district", "role"]);
		expect(repair.target.userPropertyOrder).toEqual([district, role]);
		expect(repair.target.userProperties?.[district]).toEqual({
			uuid: district,
			slug: "district",
			label: "district",
		});
		// Six reads of `district` from the session (four slots and the
		// label's calculated value in the source and in its translation),
		// three from the worker's record (the question's display condition
		// and the label's worker reference in both), and one of `role`.
		expect(repair.reboundReads).toBe(10);
		expect(repair.translationsKeptCurrent).toBe(1);
		expect(workerReads(repair.target)).toEqual(
			[
				...Array(6).fill(`id:${district}`),
				...Array(3).fill(`id:${district}@record`),
				`id:${role}`,
				"name:commcare_project",
			].sort(),
		);
		const label = repair.target.fields[QUESTION];
		expect(label && "label" in label && label.label).toEqual({
			parts: [
				{ kind: "text", text: "District: " },
				{ kind: "user-property-ref", userPropertyUuid: district },
				{ kind: "text", text: " / " },
				{
					kind: "value",
					expression: {
						kind: "term",
						term: { kind: "session-user-property", userPropertyUuid: district },
					},
				},
			],
		});
		expect(needsWorkerFieldRepair(repair.target)).toBe(false);
		expect(gateCodes(repair.target)).toEqual([]);

		// The translation is rewritten with its text and stays current.
		const unit = collectTranslationUnits(
			hydratePersistedBlueprint(repair.target),
		).find((candidate) => candidate.role === "field-label");
		const entry =
			unit && repair.target.localization?.translations.spa?.[unit.id];
		expect(entry?.sourceFingerprint).toBe(unit?.sourceFingerprint);

		const proof = verifyUndeclaredWorkerFieldRepair(
			before,
			repair,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		// The HQ import file and every entry of the archive.
		expect(proof.artifacts).toBeGreaterThan(5);
	});

	it("derives the same identities on every run and is a no-op once applied", () => {
		const before = fixture();
		const first = repairUndeclaredWorkerFields(before);
		expect(
			canonicalJsonDigest(
				repairUndeclaredWorkerFields(structuredClone(before)),
			),
		).toBe(canonicalJsonDigest(first));
		expect(workerFieldReadCensus(first.target)).toEqual({
			undeclared: [],
			declaredReadByName: 0,
		});
		const second = repairUndeclaredWorkerFields(first.target);
		expect(second.declaredSlugs).toEqual([]);
		expect(second.reboundReads).toBe(0);
		expect(canonicalJsonDigest(second.target)).toBe(
			canonicalJsonDigest(first.target),
		);
	});

	it("only rebinds the reads of a slug the app already declares", () => {
		const declared = testUuid("worker-fields-declared-district");
		const before = fixture();
		declare(before, declared, "district");
		expect(workerFieldReadCensus(before)).toEqual({
			undeclared: ["role"],
			declaredReadByName: 7,
		});
		expect(needsWorkerFieldRepair(before)).toBe(true);

		const repair = repairUndeclaredWorkerFields(before);
		expect(repair.declaredSlugs).toEqual(["role"]);
		expect(repair.target.userPropertyOrder).toEqual([
			declared,
			undeclaredWorkerFieldPropertyUuid(APP_ID, "role"),
		]);
		expect(workerReads(repair.target)).not.toContain("name:district");
		expect(workerReads(repair.target)).not.toContain("name:district@record");
		expect(workerReads(repair.target)).toContain(`id:${declared}@record`);
		expect(gateCodes(repair.target)).toEqual([]);
		expect(
			verifyUndeclaredWorkerFieldRepair(
				before,
				repair,
				LOOKUP_CONTEXT_UNAVAILABLE,
			).artifacts,
		).toBeGreaterThan(5);
	});

	it("finds an app that declares every field it reads but reads one by name", () => {
		const declaredDistrict = testUuid("worker-fields-declared-district");
		const declaredRole = testUuid("worker-fields-declared-role");
		const before = fixture();
		declare(before, declaredDistrict, "district");
		declare(before, declaredRole, "role");
		expect(workerFieldReadCensus(before).undeclared).toEqual([]);
		expect(needsWorkerFieldRepair(before)).toBe(true);
		const repair = repairUndeclaredWorkerFields(before);
		expect(repair.declaredSlugs).toEqual([]);
		expect(repair.reboundReads).toBe(8);
		verifyUndeclaredWorkerFieldRepair(
			before,
			repair,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
	});

	it("refuses what it cannot repair, naming only a reason", () => {
		// A name CommCare reserves.
		expectRefused(
			() => repairUndeclaredWorkerFields(fixture({ extraReads: ["xml_zone"] })),
			"slug-not-declarable",
		);

		// A name differing from a declared slug only in its capitals.
		const collides = fixture();
		declare(collides, testUuid("worker-fields-capital"), "District");
		expectRefused(
			() => repairUndeclaredWorkerFields(collides),
			"slug-collides",
		);

		// Two fields the repair would declare, differing only in capitals.
		expectRefused(
			() => repairUndeclaredWorkerFields(fixture({ extraReads: ["Role"] })),
			"slug-collides",
		);

		// Two declared properties holding the slug a read names.
		const twice = fixture();
		declare(twice, testUuid("worker-fields-district-a"), "district");
		declare(twice, testUuid("worker-fields-district-b"), "district");
		expectRefused(
			() => repairUndeclaredWorkerFields(twice),
			"slug-declared-twice",
		);

		// The derived identity already names another entity.
		const taken = fixture();
		declare(
			taken,
			undeclaredWorkerFieldPropertyUuid(APP_ID, "district"),
			"zone",
		);
		expectRefused(() => repairUndeclaredWorkerFields(taken), "uuid-taken");

		// A read in a translation that is out of date.
		expectRefused(
			() => repairUndeclaredWorkerFields(fixture({ translation: "stale" })),
			"stale-translation-read",
		);
	});

	it("refuses a repair whose export would change", () => {
		const before = fixture();
		const repair = repairUndeclaredWorkerFields(before);
		const district = undeclaredWorkerFieldPropertyUuid(APP_ID, "district");
		const renamed = structuredClone(repair.target);
		const property = renamed.userProperties?.[district];
		if (property === undefined) throw new Error("Expected the property.");
		property.slug = "region";
		expectRefused(
			() =>
				verifyUndeclaredWorkerFieldRepair(
					before,
					{ ...repair, target: renamed },
					LOOKUP_CONTEXT_UNAVAILABLE,
				),
			"export-changed",
		);
	});
});
