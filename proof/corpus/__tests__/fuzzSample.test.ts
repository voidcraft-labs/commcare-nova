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
 * The advanced family draws its own stream (`DEFAULT_ADVANCED_SAMPLE_SIZE`
 * at the corpus seed). Its contract is that every draw's export holds an
 * advanced menu, or names the blocker that kept the creating form's menu
 * basic, and that its draws hold at least one, so a generator change that
 * stops drawing advanced menus fails here by name; and that adding it moves
 * no draw of the original 24 or the expression eight. The observations are
 * the HQ JSON Nova's expander writes for each advanced draw, and the digest
 * of the bytes the writer writes for each of the 32, held to the digest those
 * draws had before the family joined.
 *
 * Run as a Vitest writer (`proof/corpus/emit.ts` does, inside the proof
 * image) with `NOVA_CORPUS_SAMPLE_DIR`, `NOVA_CORPUS_SAMPLE_SIZE` and
 * `NOVA_CORPUS_SAMPLE_SEED` set, the same tests run over that sample and it
 * is then written for the corpus: `index.json` and one `<id>.json` per
 * document. The sample is drawn here because its media bytes come from
 * `compilerEvidence.ts::manifestFor`, whose module imports Vitest.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CARRIED_CREATE } from "@/lib/commcare/__tests__/advancedDocArbitrary";
import { manifestFor } from "@/lib/commcare/__tests__/compilerEvidence";
import { expandDoc } from "@/lib/commcare/expander";
import { emittedModuleKind } from "@/lib/commcare/moduleKind";
import { runValidation } from "@/lib/commcare/validator/runner";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	advancedKindBlockers,
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
	DEFAULT_ADVANCED_SAMPLE_SIZE,
	DEFAULT_CORPUS_SEED,
	DEFAULT_EXPRESSION_SAMPLE_SIZE,
} from "../defaults";
import { fuzzSplit, writtenDocument } from "../documents";
import {
	type SampledDocument,
	sampleFuzzDocuments,
	sampleFuzzGenerator,
} from "../fuzzSample";

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

/** The draws every sample holds beside the original `size`: the expression and advanced streams. */
const SEPARATE_STREAMS =
	DEFAULT_EXPRESSION_SAMPLE_SIZE + DEFAULT_ADVANCED_SAMPLE_SIZE;

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

/**
 * The SHA-256 of each original and expression document of the 24 at the
 * corpus seed, over the bytes the writer writes for it. Drawing the advanced
 * family moves none of them; a change to what a generator draws or writes
 * does, and takes the new digests. Two such changes stand behind these. The
 * suite and expression documents took new bytes, and no new draw, when the
 * suite generator began declaring the worker fields its conditions read from
 * the session and reading each by its identity (`suiteDocArbitrary.ts`,
 * `undeclared-worker-field`, `worker-property-read-by-name`). Four xform, three
 * suite and two expression documents took new bytes, and no new draw, when
 * `buildField` began keeping a validation message drawn without a condition on
 * its field (`xformDocArbitrary.ts`), a message the emitter writes nowhere,
 * which the suite and expression generators build their fields through too.
 * Seventeen documents took new bytes, and no new draw, when a message's and a
 * capture's schema gained a condition, a validation and help: the same
 * fields, written in the schema's new key order.
 */
const ORIGINAL_DRAWS: Readonly<Record<string, string>> = {
	"fuzz-xform-20260930-0":
		"ad0138b64e1ce012d003e64933b2051e1c376f2a1c5f8615bb447ae314b9a6f7",
	"fuzz-xform-20260930-1":
		"08a1606671b94f046086e0c24c42c0fa78d327868c8fc864b355436e13951cd7",
	"fuzz-xform-20260930-2":
		"354ee367395a2b29d88771fda115a2ce2b60d510806a00f3882caa508ea0de84",
	"fuzz-xform-20260930-3":
		"7c62060f87ab0010df4362ff4001cf0215707750a6905035c6b7edd8ba004ce8",
	"fuzz-xform-20260930-4":
		"0ec30ecbd6a3aca37fed0b1d41a1a99bedcc75570a58588ecc6befa8389c038d",
	"fuzz-xform-20260930-5":
		"f8d94a4e26d8ba7b09de641f7c693864145962627c98cb8cfa85ed2688753767",
	"fuzz-xform-20260930-6":
		"2b71fa4c8173c5f2b7c51c1c85b9c18e0cbfd8092ce6bc974f19fe845134ba9d",
	"fuzz-xform-20260930-7":
		"005962f8ca8a997b660f318756ca2b96d49ae530a4ba38b66fb0c60fabaf2173",
	"fuzz-xform-20260930-8":
		"af6bba6b71eececb848ab3e8afd27b530d6cbd3f90f83ef2bb4c02815b439a51",
	"fuzz-xform-20260930-9":
		"07046776e16c7e32d04939f5770d5fd50922ef1104ec37e0907901dec9a80bdb",
	"fuzz-xform-20260930-10":
		"739b1191068b6513a30e730c4f1d3cdc3ddf9893c3e2942d0a5d3385fc8b0793",
	"fuzz-xform-20260930-11":
		"5a941a71aecb9acfa4c111dcc34aee1b4ba80dde6d472bb8dce19b04f921ccf3",
	"fuzz-suite-20260930-0":
		"81e666b37892004fde4b2e12b48fd8f8cc73559c8d030fba7058eae10817d2ef",
	"fuzz-suite-20260930-1":
		"ecff26e43c7cd21a058ad0314f0986d9ee3acdbab6acb4801ca40187ba607aed",
	"fuzz-suite-20260930-2":
		"ac79cdc36401d7142345293cd77967e2476be2d85e25c3bc1ebf7d319ee0889f",
	"fuzz-suite-20260930-3":
		"25b160b607b23a2f149b7aace4e0414c79fd853568f8b035ce6a29e0bb346789",
	"fuzz-suite-20260930-4":
		"25eead83da909b8e12188c93de4c80129bfbd1c3b7cd50a31535dad034164bb5",
	"fuzz-suite-20260930-5":
		"23f279730ce5a784f7c730df43d732627ba6f35b9edbb2355048225c6682a821",
	"fuzz-suite-20260930-6":
		"f6c082356cb222879d3f81123ad6b6730f9e6999e298bca80301c3206f15d865",
	"fuzz-suite-20260930-7":
		"f33ad68efaea41b5aae39e23fc6529ee360589e14f1576c7f4b699a9b6606213",
	"fuzz-suite-20260930-8":
		"4c60345be7f6e87c60e0c0f6feaaddc95f1e7d3b93b382ab88480c3488715145",
	"fuzz-suite-20260930-9":
		"568c1169a394c57c235afa0259d6e341af59f020c45423b4814331da8c855493",
	"fuzz-suite-20260930-10":
		"9f0f59c5abdd8fbba3782ae4bde289319dd95bd5dd34a4b2bf4216d66a6568d2",
	"fuzz-suite-20260930-11":
		"ddd42fd9bbcc306410280ed7edea24ce18ee72b18b52a74b848f88b67ef67df8",
	"fuzz-expression-20260930-0":
		"d8c1f2b3bfc2bf87a81d7cecb0875ba56567fdb2ef7a3a504137b52d5f19d328",
	"fuzz-expression-20260930-1":
		"6dfece4adca1ab64d0ca1710cfff270475422a2c27b7e25d8cf950db10bfd384",
	"fuzz-expression-20260930-2":
		"5cbdb1d58328e0f1e5d937c2814e9cbbc367b3fc53c740c44b639502c7b48b98",
	"fuzz-expression-20260930-3":
		"308a4ce6cb8448d43ed67985e84da558cbda4e499a51e9b38f1dff2b0e05d81f",
	"fuzz-expression-20260930-4":
		"47126db71c55db4bc669db6f836e320aebdc11e3ffae72db9c814be2f73decf6",
	"fuzz-expression-20260930-5":
		"f3e4fb7fbb4c0c9e1ff388c51e118f1cab89bb7172559acafd1342cb8ba15032",
	"fuzz-expression-20260930-6":
		"7953713af344a9edcae6daf816894a98d2fd43f967f65ba449dbcb68c8e138e9",
	"fuzz-expression-20260930-7":
		"e1999d660cbfaf761273615a4ad75ded338b1307afab6373f10e6d15745418d6",
};

/** The SHA-256 of the bytes the writer writes for a sampled document. */
function writtenDigest(sampled: SampledDocument): string {
	return createHash("sha256")
		.update(
			JSON.stringify(
				writtenDocument(sampled.document.doc, sampled.document.media),
			),
		)
		.digest("hex");
}

function draw(sampleSize: number, sampleSeed = seed): SampledDocument[] {
	return sampleFuzzDocuments({
		size: sampleSize,
		seed: sampleSeed,
		manifestFor,
	});
}

// Each test draws the sample again, once or more, and a draw validates every
// document it makes, so a test takes seconds on a hosted runner.
describe("the corpus's fuzz sample", { timeout: 60_000 }, () => {
	let sample: SampledDocument[] = [];
	beforeAll(() => {
		sample = draw(size);
	});

	it("admits every document, read back from what the writer writes", () => {
		expect(sample).toHaveLength(size + SEPARATE_STREAMS);
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
			...Array.from({ length: DEFAULT_ADVANCED_SAMPLE_SIZE }, () => "advanced"),
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

	it("draws an advanced menu in its advanced family, and every advanced draw's export holds one or names what kept its menu basic", () => {
		const family = sampleFuzzGenerator({
			generator: "advanced",
			count: DEFAULT_ADVANCED_SAMPLE_SIZE,
			seed: DEFAULT_CORPUS_SEED,
			manifestFor,
		});
		expect(family).toHaveLength(DEFAULT_ADVANCED_SAMPLE_SIZE);
		let advanced = 0;
		for (const sampled of family) {
			const id = sampled.document.id;
			const written = (asWritten(sampled) as { doc: unknown }).doc;
			const doc = hydratePersistedBlueprint(blueprintDocSchema.parse(written));
			const creating = Object.values(doc.forms).find((form) =>
				(form.caseOperations ?? []).some(
					(operation) => operation.uuid === CARRIED_CREATE,
				),
			);
			const moduleUuid =
				creating === undefined
					? undefined
					: moduleUuidOfForm(doc, creating.uuid);
			if (moduleUuid === undefined) {
				throw new Error(
					`The advanced draw ${id} holds no form with the carried create, so the family drew a document its generator never makes.`,
				);
			}
			const exported = expandDoc(doc, {
				assets: manifestFor(doc),
			}).modules.filter((module) => module.doc_type === "AdvancedModule");
			const kind = emittedModuleKind(doc, moduleUuid);
			expect(exported.length > 0, id).toBe(kind === "advanced");
			if (kind === "advanced") {
				advanced += 1;
			} else {
				expect(
					advancedKindBlockers(doc, moduleUuid).map((blocker) => blocker.kind),
					`${id} exports no advanced menu, so a blocker keeps the creating form's menu basic`,
				).not.toEqual([]);
			}
		}
		expect(
			advanced,
			`The advanced family's ${DEFAULT_ADVANCED_SAMPLE_SIZE} draws at the corpus seed hold no advanced menu, so the family checks nothing. Raise DEFAULT_ADVANCED_SAMPLE_SIZE (proof/corpus/defaults.ts) until they hold one, or look at what advancedDocArbitrary now draws.`,
		).toBeGreaterThan(0);
	});

	it("moves no draw of the original generators or the expression family by drawing the advanced family", () => {
		const sample = sampleFuzzDocuments({
			size: 24,
			seed: DEFAULT_CORPUS_SEED,
			manifestFor,
		});
		expect(fuzzSplit(24)).toEqual({
			xform: 12,
			suite: 12,
			expression: DEFAULT_EXPRESSION_SAMPLE_SIZE,
			advanced: DEFAULT_ADVANCED_SAMPLE_SIZE,
		});
		const drawn = new Map(
			sample
				.filter((sampled) => sampled.generator !== "advanced")
				.map((sampled) => [sampled.document.id, writtenDigest(sampled)]),
		);
		expect([...drawn.keys()]).toEqual(Object.keys(ORIGINAL_DRAWS));
		for (const [id, digest] of Object.entries(ORIGINAL_DRAWS))
			expect(
				drawn.get(id),
				`${id} is no longer the document the corpus seed drew before the advanced family. A generator, the admission or the written form moved it. If that change is meant, take the new digest; if not, look at what draws or writes it now.`,
			).toBe(digest);
	});

	afterAll(() => {
		// A sample that could not be drawn in full is not written; the
		// failing test says why.
		if (destination === undefined || sample.length !== size + SEPARATE_STREAMS)
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
