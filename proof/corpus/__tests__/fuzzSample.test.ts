/**
 * The corpus's fuzz sample: admitted, and fixed by its seed.
 *
 * In ordinary CI this draws a small sample and proves what the corpus's ids
 * rest on: the same seed draws the same documents (stored form and uploaded
 * media, byte for byte), another seed draws others, a document drawn in a
 * smaller sample is the same document in a larger one, and every document,
 * read back from the JSON the writer writes, passes the strict schema and
 * full validation.
 *
 * Run as a Vitest writer (`proof/corpus/emit.ts` does, inside the proof
 * image) with `NOVA_CORPUS_SAMPLE_DIR`, `NOVA_CORPUS_SAMPLE_SIZE` and
 * `NOVA_CORPUS_SAMPLE_SEED` set, the same tests run over that sample and it
 * is then written for the corpus: `index.json` and one `<id>.json` per
 * document. The sample is drawn here because its media bytes come from
 * `compilerEvidence.ts::manifestFor`, whose module imports Vitest.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { manifestFor } from "@/lib/commcare/__tests__/compilerEvidence";
import { runValidation } from "@/lib/commcare/validator/runner";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	CASE_LOADING_FORM_TYPES,
	caseSelectionCardinality,
	declaresWebApps,
	fieldCaseWriteViews,
	fieldKindDeclaresKey,
	fieldPreload,
	moduleSearchWorkflow,
	moduleUuidOfForm,
} from "@/lib/domain";
import { proseTemplateIsEmpty } from "@/lib/domain/prose";
import {
	DEFAULT_CORPUS_SEED,
	DEFAULT_EXPRESSION_SAMPLE_SIZE,
} from "../defaults";
import { writtenDocument } from "../documents";
import { type SampledDocument, sampleFuzzDocuments } from "../fuzzSample";

const destination = process.env.NOVA_CORPUS_SAMPLE_DIR;

function wholeNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(
			`${name} holds a whole number (a sample size or a seed); got ${JSON.stringify(raw)}.`,
		);
	}
	return value;
}

const seed = wholeNumber("NOVA_CORPUS_SAMPLE_SEED", DEFAULT_CORPUS_SEED);
const size = wholeNumber("NOVA_CORPUS_SAMPLE_SIZE", 4);

/** A sampled document as the writer writes it, parsed back from its JSON text. */
function asWritten(sampled: SampledDocument): unknown {
	return JSON.parse(
		JSON.stringify(
			writtenDocument(sampled.document.doc, sampled.document.media),
		),
	);
}

/**
 * Whether a question of `doc` opened with its case's value before step 5
 * without saying so: it saves to the own case of a follow-up or close form
 * of a one-case menu, as a question that holds no calculation and can hold a
 * starting value, and its starting value is not the read of that property
 * (`fieldPreload`). Before step 5 the form loaded the case's value into it
 * by rule; after it, only a starting value that reads the case does.
 */
function opensWithCaseValueUnstated(doc: BlueprintDoc): boolean {
	return Object.values(doc.fields).some((field) => {
		if (!fieldKindDeclaresKey(field.kind, "default_value")) return false;
		if ("calculate" in field && field.calculate !== undefined) return false;
		return fieldCaseWriteViews(doc, field.uuid).some((view) => {
			const form = doc.forms[view.formUuid];
			const moduleUuid = moduleUuidOfForm(doc, view.formUuid);
			const module =
				moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
			return (
				form !== undefined &&
				module !== undefined &&
				CASE_LOADING_FORM_TYPES.has(form.type) &&
				caseSelectionCardinality(module) === "single" &&
				view.destination === "own" &&
				view.slot !== "owner" &&
				!view.link &&
				view.via === undefined &&
				fieldPreload(field)?.property !== view.property
			);
		});
	});
}

/** The written document's stored entities, read before the schema parses them. */
interface WrittenShapes {
	readonly fields?: Record<string, object>;
	readonly modules?: Record<string, { readonly caseSearchConfig?: object }>;
}

/**
 * Each step 5 shape a draw could hold that the cutover maps in a stored app,
 * read from the drawn document as the writer writes it (`written`, before
 * the strict schema reads it), the document and the codes its validation
 * raises, so the observation is the document's and the gate's and not the
 * mapping's own planner. Pull requests that make another drawn shape
 * inadmissible add theirs here.
 */
const STEP_5_SHAPES: readonly {
	readonly name: string;
	readonly heldBy: (
		doc: BlueprintDoc,
		codes: ReadonlySet<string>,
		written: WrittenShapes,
	) => boolean;
}[] = [
	{
		name: "a repeat count that isn't a whole number",
		heldBy: (_doc, codes) => codes.has("REPEAT_COUNT_TYPE"),
	},
	{
		name: "a question that says where its answer is saved",
		heldBy: (_doc, _codes, written) =>
			Object.values(written.fields ?? {}).some((field) =>
				Object.hasOwn(field, "caseWrite"),
			),
	},
	{
		name: "a question that opens with its case's value without saying so",
		heldBy: (doc) => opensWithCaseValueUnstated(doc),
	},
	{
		name: "a group shown on one screen that holds a repeat workers add entries to",
		heldBy: (_doc, codes) => codes.has("FIELD_LIST_USER_REPEAT"),
	},
	{
		name: "a labelled group with no such repeat that doesn't show on one screen",
		heldBy: (doc) =>
			labelledGroups(doc).some(
				(group) => !group.holdsUserRepeat && group.fieldList !== true,
			),
	},
	{
		name: "a search that opens on its case list where Web Apps is declared",
		heldBy: (doc) =>
			declaresWebApps(doc) &&
			Object.values(doc.modules).some(
				(module) => moduleSearchWorkflow(module) === "listFirst",
			),
	},
	{
		name: "a search that stores searchFirst",
		heldBy: (_doc, _codes, written) =>
			Object.values(written.modules ?? {}).some(
				(module) =>
					module.caseSearchConfig !== undefined &&
					Object.hasOwn(module.caseSearchConfig, "searchFirst"),
			),
	},
];

/**
 * Each group of `doc` whose label has text (the sample draws no
 * translations, so its source label is the label every language shows),
 * whether it shows on one screen, and whether a repeat workers add entries
 * to sits under it at any depth.
 */
function labelledGroups(doc: BlueprintDoc): {
	readonly fieldList: boolean | undefined;
	readonly holdsUserRepeat: boolean;
}[] {
	const underUserRepeat = (parentUuid: string): boolean =>
		(doc.fieldOrder[parentUuid as keyof typeof doc.fieldOrder] ?? []).some(
			(uuid) => {
				const field = doc.fields[uuid];
				return (
					(field?.kind === "repeat" &&
						field.repeat_mode === "user_controlled") ||
					underUserRepeat(uuid)
				);
			},
		);
	return Object.values(doc.fields).flatMap((field) =>
		field.kind === "group" &&
		field.label !== undefined &&
		!proseTemplateIsEmpty(field.label)
			? [
					{
						fieldList: field.fieldList,
						holdsUserRepeat: underUserRepeat(field.uuid),
					},
				]
			: [],
	);
}

function draw(sampleSize: number, sampleSeed = seed): SampledDocument[] {
	return sampleFuzzDocuments({
		size: sampleSize,
		seed: sampleSeed,
		manifestFor,
	});
}

describe("the corpus's fuzz sample", () => {
	let sample: SampledDocument[] = [];
	beforeAll(() => {
		sample = draw(size);
	});

	it("admits every document, read back from what the writer writes", () => {
		expect(sample).toHaveLength(size + DEFAULT_EXPRESSION_SAMPLE_SIZE);
		for (const sampled of sample) {
			const written = asWritten(sampled) as { doc: unknown };
			const parsed = blueprintDocSchema.safeParse(written.doc);
			expect(parsed.success, sampled.document.id).toBe(true);
			if (!parsed.success) continue;
			expect(
				runValidation(
					hydratePersistedBlueprint(parsed.data),
					LOOKUP_CONTEXT_UNAVAILABLE,
				).map((finding) => finding.code),
				sampled.document.id,
			).toEqual([]);
		}
	});

	it("draws the same documents for a seed, and other documents for another seed", () => {
		const pair = draw(2);
		expect(draw(2).map(asWritten)).toEqual(pair.map(asWritten));
		expect(draw(2, seed + 1).map(asWritten)).not.toEqual(pair.map(asWritten));
	});

	it("gives a document the same content whatever the sample's size", () => {
		// Sizes fixed here rather than taken from the requested sample, so the
		// writer runs for any size the lane asks for, none included.
		const larger = new Map(
			draw(4).map((sampled) => [sampled.document.id, asWritten(sampled)]),
		);
		const smaller = draw(2);
		expect(smaller.map((s) => s.generator)).toEqual([
			"xform",
			"suite",
			...Array.from(
				{ length: DEFAULT_EXPRESSION_SAMPLE_SIZE },
				() => "expression",
			),
		]);
		for (const document of smaller) {
			expect(larger.has(document.document.id), document.document.id).toBe(true);
			expect(larger.get(document.document.id), document.document.id).toEqual(
				asWritten(document),
			);
		}
	});

	it("declares each draw for the platforms its content runs on and splits the date-and-time questions of one that runs on neither, with no further draw", () => {
		const declared = new Map(
			sampleFuzzDocuments({
				size: 24,
				seed: DEFAULT_CORPUS_SEED,
				manifestFor,
			}).map((sampled) => [sampled.document.id, sampled.document.doc]),
		);
		const runsOnlyOn = (id: string) => {
			const doc = declared.get(id);
			if (doc === undefined) throw new Error(`The sample holds no ${id}.`);
			return doc.appSettings.runsOnlyOn;
		};
		expect(runsOnlyOn("fuzz-xform-20260930-0")).toBe("android");
		expect(runsOnlyOn("fuzz-xform-20260930-2")).toBe("android");
		expect(runsOnlyOn("fuzz-suite-20260930-0")).toBeUndefined();
		expect(runsOnlyOn("fuzz-suite-20260930-8")).toBe("web-apps");
		const split = Object.values(
			declared.get("fuzz-suite-20260930-8")?.fields ?? {},
		);
		expect(split.map((field) => field.id)).toEqual(
			expect.arrayContaining(["model_date", "model_time"]),
		);
		expect(split.filter((field) => field.kind === "datetime")).toEqual([]);
	});

	it("maps each step 5 shape of a draw as the cutover maps a stored app, with no further draw", () => {
		const sample = sampleFuzzDocuments({
			size: 24,
			seed: DEFAULT_CORPUS_SEED,
			manifestFor,
		});
		let saving = 0;
		let oneScreen = 0;
		let searching = 0;
		for (const sampled of sample) {
			const written = (asWritten(sampled) as { doc: WrittenShapes }).doc;
			const doc = hydratePersistedBlueprint(blueprintDocSchema.parse(written));
			const codes = new Set(
				runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map(
					(finding) => finding.code,
				),
			);
			expect(
				STEP_5_SHAPES.filter((shape) => shape.heldBy(doc, codes, written)).map(
					(shape) => shape.name,
				),
				sampled.document.id,
			).toEqual([]);
			if (
				Object.values(doc.forms).some((form) =>
					(form.caseOperations ?? []).some(
						(operation) => (operation.writes?.length ?? 0) > 0,
					),
				)
			)
				saving += 1;
			oneScreen += labelledGroups(doc).filter(
				(group) => group.fieldList === true,
			).length;
			searching += Object.values(doc.modules).filter(
				(module) => moduleSearchWorkflow(module) !== undefined,
			).length;
		}
		// The drawn saves are there, as operations: the mapping kept them.
		expect(saving).toBeGreaterThan(0);
		// The drawn labelled groups are there, each on one screen.
		expect(oneScreen).toBeGreaterThan(0);
		// The drawn searches are there, each with the workflow the mapping gave it.
		expect(searching).toBeGreaterThan(0);
		// The mapping draws nothing: a smaller draw is the start of a larger one.
		const written = new Map(
			sample.map((sampled) => [sampled.document.id, asWritten(sampled)]),
		);
		for (const sampled of draw(2, DEFAULT_CORPUS_SEED))
			expect(written.get(sampled.document.id), sampled.document.id).toEqual(
				asWritten(sampled),
			);
	});

	afterAll(() => {
		// A sample that could not be drawn in full is not written; the
		// failing test says why.
		if (
			destination === undefined ||
			sample.length !== size + DEFAULT_EXPRESSION_SAMPLE_SIZE
		)
			return;
		mkdirSync(destination, { recursive: true });
		for (const sampled of sample) {
			writeFileSync(
				resolve(destination, `${sampled.document.id}.json`),
				JSON.stringify(
					writtenDocument(sampled.document.doc, sampled.document.media),
				),
			);
		}
		writeFileSync(
			resolve(destination, "index.json"),
			JSON.stringify(
				{
					seed,
					size: sample.length,
					documents: sample.map((sampled) => ({
						id: sampled.document.id,
						generator: sampled.generator,
						index: sampled.index,
						file: `${sampled.document.id}.json`,
					})),
				},
				null,
				"\t",
			),
		);
	});
});
