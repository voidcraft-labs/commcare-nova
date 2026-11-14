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
 * corpus seed, over the bytes the writer writes for it, as they were drawn
 * before the advanced family joined the sample.
 */
const ORIGINAL_DRAWS: Readonly<Record<string, string>> = {
	"fuzz-xform-20260930-0":
		"c4062d192592b9c65e1b2ca3606a5a2b7e0ab94f956fe33fda97fcd4f5e9e84b",
	"fuzz-xform-20260930-1":
		"08a1606671b94f046086e0c24c42c0fa78d327868c8fc864b355436e13951cd7",
	"fuzz-xform-20260930-2":
		"354ee367395a2b29d88771fda115a2ce2b60d510806a00f3882caa508ea0de84",
	"fuzz-xform-20260930-3":
		"ed62e43dec0303bdf847700adcaf3780cb3c0a45e3f7e993fb96b06cdb805f41",
	"fuzz-xform-20260930-4":
		"a3adc2c564df3cbcbe286565d33b9554d7ef88d74026ca38f2502815868f9e79",
	"fuzz-xform-20260930-5":
		"f8d94a4e26d8ba7b09de641f7c693864145962627c98cb8cfa85ed2688753767",
	"fuzz-xform-20260930-6":
		"cab6977a662baa611ceca0230c40a59fb4c985851d1380a819e27525080ffac8",
	"fuzz-xform-20260930-7":
		"060fd4f1bbacb43c0661c344d7bf0fc27a7c0a3e94b731ac6d8161ce1dfb0b27",
	"fuzz-xform-20260930-8":
		"3b2318a52e9ff191821269dbd0a62e3d57ed114f4ba946d6a78f4d85df07eb69",
	"fuzz-xform-20260930-9":
		"b72e3fca7be2f3341a9c9e34cd6224254ecbeca2cbefd1230519646e6f542495",
	"fuzz-xform-20260930-10":
		"042649e5650e1892bb8120876b959b7975697f46d7fccaf36a41d68930658911",
	"fuzz-xform-20260930-11":
		"c3db59e35973ed260663c9253dbd0ff1d43d6f0ba4be66bda886ec0e8f829154",
	"fuzz-suite-20260930-0":
		"9012db0aa580b5bb6d39048b1eea008fa5081a7b2547a4c2763024ae6c91fa6d",
	"fuzz-suite-20260930-1":
		"070fec06339e8bd634de6586fb59218855389269db5f0e4d42ce48db8cb0e46e",
	"fuzz-suite-20260930-2":
		"fa3771fe97dd84517561aae2687490e7813c3391f664e9d116979f22ad22da2f",
	"fuzz-suite-20260930-3":
		"792e8c51ae490f59556b5288b6dc82b32d2aef4d11d2a3bc241369514d37a12f",
	"fuzz-suite-20260930-4":
		"c94825a6f81e20076d492fc0517910682097f772cafa95cdf885435efe49914e",
	"fuzz-suite-20260930-5":
		"df6ee025444dd197a90b4d518f002fc1bccbe1cfc25decfbb8517e3c56c21145",
	"fuzz-suite-20260930-6":
		"221147d81c5b2f9281712ec21888a20a470a8c843d5721e526973892b117220b",
	"fuzz-suite-20260930-7":
		"6bd41eb872535850d51d82059db03edc714c8bd615080a72691eed013114b720",
	"fuzz-suite-20260930-8":
		"380245eefb6ffce6e68303a8d20b2393b47b142a3e229f5eabd6490098307d4b",
	"fuzz-suite-20260930-9":
		"da534503b5584854c2ca727c704bbe0b0e83215f6ed257b552432b1e436663d7",
	"fuzz-suite-20260930-10":
		"9f0f59c5abdd8fbba3782ae4bde289319dd95bd5dd34a4b2bf4216d66a6568d2",
	"fuzz-suite-20260930-11":
		"c192946e80a4a7974d0608907ec0aed774843f2aeac39191361413ec36400155",
	"fuzz-expression-20260930-0":
		"eac8c4d0a39cc97c0f2887e1dddef9d317c70a3e910b84ae334c46b9d6355b98",
	"fuzz-expression-20260930-1":
		"9a8bebdbc50739fbee63bc4f016f42330ac72d83478a4f10f967d3983b5ac066",
	"fuzz-expression-20260930-2":
		"2c22993e36de75f18c7e95297fa7d37210e7415209b87f992918d1b748fdb747",
	"fuzz-expression-20260930-3":
		"322213ecfdfbc1226187808b22d9e9bee324245dd935c8fdbe5e5dba0dd604c2",
	"fuzz-expression-20260930-4":
		"70e20115391e406b3cecef0a8a76ab76ebb836d4627fe380543d3dba9ea79634",
	"fuzz-expression-20260930-5":
		"788b829309a9f5b9139ea423c7f3a4cbbb26902d4e5b0967b30e9e1af3197983",
	"fuzz-expression-20260930-6":
		"69ffb84ac032f3fca9c54ccd1446d6c243d8e4ad07aa6f5519e83dabe8f2ca56",
	"fuzz-expression-20260930-7":
		"5a75ff03f31e5531951b228c1eb7e46f5c0a03fbaa78bdc0f73d6bc5eeeb1002",
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
