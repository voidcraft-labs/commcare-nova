/**
 * The ordered transform over every frozen fixture: what it does to the
 * stored document, that its output is a document the tree's schema, gate
 * and export readiness admit, that a second application changes nothing,
 * that authored question paths and derived case schemas hold, and the
 * notice lines each step mints. Each pull request that registers a step adds
 * its expectations here.
 */

import { describe, expect, it } from "vitest";
import { buildCaseTypeMap } from "@/lib/case-store/store";
import {
	exportReadinessFindings,
	mutationCommitVerdict,
} from "@/lib/doc/commitVerdicts";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { blueprintDocSchema } from "@/lib/domain";
import { caseTypeToJsonSchema } from "@/lib/domain/predicate/jsonSchema";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { lookupContextOf } from "@/proof/corpus/documents";
import { legacyWireCodes } from "../legacyLanguageWireCodes";
import {
	rawDocumentAssembly,
	rawDocumentDigest,
	readRawDocument,
} from "../oldShape";
import { caseSchemaDifferences } from "../plan";
import { questionPaths } from "../questionPaths";
import {
	CUTOVER_STEPS,
	type StepContext,
	transformDocument,
} from "../transform";
import { readLegacyApp } from "./fixtures/legacyBodies";
import {
	fixtureMediaRecords,
	migratedFixtureDocument,
	readFixtureCarriers,
	readFixtureManifest,
	readFixturePaths,
	readFixtureProject,
	readFixtureSchemas,
} from "./fixtures/preStep";

const PROJECT = "fixture-project";

function contextFor(appId: string): StepContext {
	return {
		appId,
		projectId: PROJECT,
		lookupColumnTypes: new Map(),
		deployments: [
			{
				deploymentId: "00000000-0000-7000-8000-00000000d001",
				outcome: "unreadable",
				profileProperties: null,
			},
		],
	};
}

const manifest = readFixtureManifest().fixtures;
const fixtures = manifest.map((fixture) => fixture.id);

/** Whether a fixture is built to witness a blocker code. */
function witnesses(id: string, code: string): boolean {
	return (
		manifest.find((fixture) => fixture.id === id)?.blockers.includes(code) ===
		true
	);
}

describe("the ordered transform", () => {
	it("registers its steps in the one fixed order", () => {
		const order = [
			"language-wire-codes",
			"media-slots",
			"hidden-inert-default",
			"search-button-label",
			"question-ids",
			"case-operation-ids",
			"connect-ids",
			"connect-task-forms",
			"entry-point-ids",
			"option-values",
			"option-labels",
			"empty-forms",
			"unsupplied-session-reads",
			"reserved-search-inputs",
			"time-ordering",
			"hidden-from-menu",
			"post-submit",
			"id-mapping-keys",
			"date-patterns",
			"tile-hidden-calculated-sort",
			"sort-property-ownership",
			"tile-cells",
			"app-settings",
		];
		const registered = CUTOVER_STEPS.map((step) => step.id);
		expect(registered).toEqual(order.filter((id) => registered.includes(id)));
	});

	describe.each(fixtures)("over %s", (id) => {
		const raw = readRawDocument(id, readFixtureCarriers(id));
		const project = readFixtureProject(id);
		const result = transformDocument(raw, contextFor(id));

		it("leaves the document the plan read untouched", () => {
			expect(rawDocumentDigest(raw)).toBe(
				rawDocumentDigest(readRawDocument(id, readFixtureCarriers(id))),
			);
		});

		it("changes nothing a second time", () => {
			const again = transformDocument(result.target, contextFor(id));
			expect(again.changes).toEqual([]);
			expect(rawDocumentDigest(again.target)).toBe(
				rawDocumentDigest(result.target),
			);
		});

		it("writes a target the schema, the gate and export readiness admit", () => {
			const parsed = blueprintDocSchema.safeParse(
				rawDocumentAssembly(id, result.target),
			);
			expect(parsed.success).toBe(true);
			if (!parsed.success) return;
			const doc = hydratePersistedBlueprint(parsed.data);
			const lookupContext = lookupContextOf(project.lookup as never);
			const verdict = mutationCommitVerdict(doc, [], lookupContext);
			expect(verdict.ok ? [] : verdict.findings.map((f) => f.code)).toEqual([]);
			const media = new Map(
				fixtureMediaRecords(
					project,
					lookupContext.kind === "available"
						? lookupContext.projectId
						: PROJECT,
					"fixture-owner",
				).map((record) => [record.id as string, record]),
			);
			const exportFindings = exportReadinessFindings(
				doc,
				lookupContext,
				media,
			).map((f) => f.code);
			if (witnesses(id, "target-export-readiness")) {
				expect(exportFindings).toContain("MEDIA_ASSET_NOT_FOUND");
			} else {
				expect(exportFindings).toEqual([]);
			}
		});

		it("keeps every authored question path a step does not rename", () => {
			expect(questionPaths(result.target)).toEqual(readFixturePaths(id));
		});

		it("derives the case schemas the fixture's stored rows hold", () => {
			const parsed = blueprintDocSchema.parse(
				rawDocumentAssembly(id, result.target),
			);
			const doc = hydratePersistedBlueprint(parsed);
			const stored = readFixtureSchemas(id);
			if (witnesses(id, "case-schema-change")) {
				expect(
					caseSchemaDifferences(
						doc,
						new Map(
							Object.entries(stored).map(([name, schema]) => [
								name,
								JSON.stringify(schema),
							]),
						),
					),
				).toBeGreaterThan(0);
				return;
			}
			expect(
				caseSchemaDifferences(
					doc,
					new Map(
						Object.entries(stored).map(([name, schema]) => [
							name,
							JSON.stringify(schema),
						]),
					),
				),
			).toBe(0);
			expect(
				Object.fromEntries(
					[...buildCaseTypeMap(doc)].map(([name, caseType]) => [
						name,
						canonicalJsonDigest(caseTypeToJsonSchema(caseType)),
					]),
				),
			).toEqual(
				Object.fromEntries(
					Object.entries(stored).map(([name, schema]) => [
						name,
						canonicalJsonDigest(schema),
					]),
				),
			);
		});
	});

	it("counts a stored schema that differs, a derived type with no row and a row with no derived type", () => {
		const id = "case-operation-query";
		const doc = migratedFixtureDocument(id);
		const stored = new Map(
			Object.entries(readFixtureSchemas(id)).map(([name, schema]) => [
				name,
				JSON.stringify(schema),
			]),
		);
		expect(caseSchemaDifferences(doc, stored)).toBe(0);
		const [first] = [...stored.keys()];
		if (first === undefined)
			throw new Error("The fixture derives no case type.");
		const retyped = new Map(stored);
		retyped.set(first, JSON.stringify({ type: "object", properties: {} }));
		expect(caseSchemaDifferences(doc, retyped)).toBe(1);
		const missing = new Map(stored);
		missing.delete(first);
		expect(caseSchemaDifferences(doc, missing)).toBe(1);
		const extra = new Map(stored);
		extra.set(
			"retired_type",
			JSON.stringify({ type: "object", properties: {} }),
		);
		expect(caseSchemaDifferences(doc, extra)).toBe(1);
	});
});

describe("step language-wire-codes", () => {
	const corpus = manifest.filter((fixture) => fixture.kind === "corpus");

	it.each(corpus.map((fixture) => fixture.id))(
		"gives %s the codes its pre-step export sent",
		(id) => {
			const raw = readRawDocument(id, readFixtureCarriers(id));
			const { target, steps } = transformDocument(raw, contextFor(id));
			expect(
				steps.find((step) => step.stepId === "language-wire-codes")?.changes,
			).toEqual([]);
			const sent = readLegacyApp(id, "create").langs as string[];
			if (raw.localization === null) {
				expect(target.localization).toBeNull();
				expect(sent).toEqual(["en"]);
				return;
			}
			const localization = target.localization as {
				languageOrder: string[];
				wireCodes: Record<string, string>;
			};
			expect(
				localization.languageOrder.map((tag) => localization.wireCodes[tag]),
			).toEqual(sent);
		},
	);

	it("is held by at least one corpus fixture with a stored root", () => {
		expect(
			corpus.some(
				(fixture) =>
					readRawDocument(fixture.id, readFixtureCarriers(fixture.id))
						.localization !== null,
			),
		).toBe(true);
	});

	it("keeps the pre-step grouping, which suffixed every language of a shared spelling", () => {
		expect(legacyWireCodes({ languageOrder: ["eng", "spa", "fra"] })).toEqual({
			eng: "en",
			spa: "es",
			fra: "fra",
		});
		expect(
			legacyWireCodes({ languageOrder: ["eng", "cmn-Hans", "cmn-Hant"] }),
		).toEqual({ eng: "en", "cmn-Hans": "cmn-hans", "cmn-Hant": "cmn-hant" });
		expect(legacyWireCodes({ languageOrder: ["eng", "cmn-Hans"] })).toEqual({
			eng: "en",
			"cmn-Hans": "zho",
		});
		expect(
			legacyWireCodes({ languageOrder: ["eng", "spa", "eng-GB"] }),
		).toEqual({ eng: "eng-", spa: "es", "eng-GB": "eng-gb" });
	});
});
