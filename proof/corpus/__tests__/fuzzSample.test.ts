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
 * fields, written in the schema's new key order. Every document took new
 * bytes, and no new draw, when an app's Connect type became its set of
 * Connect roles and each form's Connect blocks became activities at their
 * places: a draw's released blocks are converted as the stored apps are
 * (`releasedConnectShape.mjs`).
 */
const ORIGINAL_DRAWS: Readonly<Record<string, string>> = {
	"fuzz-xform-20260930-0":
		"53ffc54d271b8f175d52cbe0050ca14f101a238a5073ce94dbf003d3ece9a432",
	"fuzz-xform-20260930-1":
		"f56f5ba705c8426a3810a63772e34a2db1ba0c94f031efff57b1b3a03069b33c",
	"fuzz-xform-20260930-2":
		"42ef0c6e28a8f20d1ec153118b877bca65cb4967c89d4a047c41f2a834ccb145",
	"fuzz-xform-20260930-3":
		"962feffba36d045d69f53cc0636a6508648480b4dadd34b901c4442631f463a2",
	"fuzz-xform-20260930-4":
		"a31213b4d79453faed7ff2785a0a4cf928ba091294e517dee7ee58816a9c708d",
	"fuzz-xform-20260930-5":
		"fd8297c0142ea2fea4970f74e5ea3c00c3cf1ee2efdf44c7f9757b1632ad9c65",
	"fuzz-xform-20260930-6":
		"1f22068de61c76e015159d202417e8cb4dbf6d8413300b469edcc612cbe0476b",
	"fuzz-xform-20260930-7":
		"2b91a215f80b9229af6079003d2d1dbd919074d6630b3c817347bc17a898447b",
	"fuzz-xform-20260930-8":
		"8776a11278f36e27cb58eeceb87c40cbd293fc2625da31533bec7141b3e59bb8",
	"fuzz-xform-20260930-9":
		"61c56cfe8ebbff02dd6de037884b520a14d7e78abc41863e5205dada101a7ae3",
	"fuzz-xform-20260930-10":
		"319dbeaad7b2258032a0d049d1cd971630959d07b17256c6758750b0383441a2",
	"fuzz-xform-20260930-11":
		"d3f421a5884c646f4455d212d3030b36a1eeb003b4669150c2402e52b241a42e",
	"fuzz-suite-20260930-0":
		"b4e3cd975a16c414abe9b9d9b8c577320ccf5a67d2545a3d315b14060c79f55e",
	"fuzz-suite-20260930-1":
		"0f552d4e6263d6a61182f98e029813b6fbbb923203ad8fb635997621a971fc6f",
	"fuzz-suite-20260930-2":
		"b43fb59d33d83e1b992d1392f3035fb58cffc457eaa6a90df2da9971a8a7cde8",
	"fuzz-suite-20260930-3":
		"9eea60f6c3e13defe246b90e0ff6ddcfa49ec6157a9afc1f02b475b548997c96",
	"fuzz-suite-20260930-4":
		"3ea263edd9508620c76ada7b09b0801acfaa9458586cb4fb6157f3692711c418",
	"fuzz-suite-20260930-5":
		"dc03b50f7a6b0a79c0e0a27996bd483f1e5909fb0a9eda1c98e34c9b05bfb8e6",
	"fuzz-suite-20260930-6":
		"6688091dee13b9b889ede3987420b56c5a74e71f6754d6773eac931206449e26",
	"fuzz-suite-20260930-7":
		"fbdeec3b045187e6f6bcd6d066644508a53f259fe77f4953f6b0b5f8851cb5d9",
	"fuzz-suite-20260930-8":
		"6e63d48e1bb0cb2e69ef3f228fd413dfeb478632c22e46b83a372eaa791bf3a7",
	"fuzz-suite-20260930-9":
		"31c6f174d489debbaca2345f5c85f8936a45d977a4f79fa7c34537dda4e99eaf",
	"fuzz-suite-20260930-10":
		"72e13ab7103dbfbf3ffa95c75d6196e303bf05e9a900c8d638f5452d82cf64ad",
	"fuzz-suite-20260930-11":
		"104e6dabc779c86f5f9d8119185d480fab207473dc5e09172476aa7abde6ea30",
	"fuzz-expression-20260930-0":
		"2456529a4901c35ad1049dacb22b4cab043c0958c1035c7a6a18635d61ab2a6d",
	"fuzz-expression-20260930-1":
		"4b54b508620f6fb5d6302765ed51f7fee3d799fe602fc31ac534beefd83c832a",
	"fuzz-expression-20260930-2":
		"a0683017e0184882b1cb4d260d3dd9573feeee0c41a309da487bf6a72cd91c6e",
	"fuzz-expression-20260930-3":
		"efcbf4f54434fb3f65669a736ad60545311671722c654b6f80ccf7cb3b6ccc0b",
	"fuzz-expression-20260930-4":
		"a94faf1c4b451832bab76d53245bf62de2a5176ce080a8bee75022e8860720fc",
	"fuzz-expression-20260930-5":
		"2b3cb74fe12bdc043500f611d49471d876999db625047ac34f6fae58cfe6be67",
	"fuzz-expression-20260930-6":
		"8396d1c83580842f8b2ac90e051c5bf951f308e4c65116a2ec3123c83d69c7a2",
	"fuzz-expression-20260930-7":
		"e23a1301ed2e32a50dbd25a4013c00410839e40ceef38efa504b345c0a085c83",
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
