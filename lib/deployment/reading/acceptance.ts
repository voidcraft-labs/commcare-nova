/**
 * Acceptance of a reading of CommCare HQ's app: the one judge of whether the
 * document a clean reading gave may become an app. Five checks, in order,
 * the first that finds a difference ending the function:
 *
 * 1. accounting: no reader defect, every hand-off settled exactly once by
 *    project data, and no settlement of a hand-off the reader never made;
 * 2. gate: the commit gate and the export readiness of a first publish under
 *    every declaration the review will offer;
 * 3. fixed point: re-reading Nova's own emission of the document gives it
 *    exactly, and so does the split document a declaration can make;
 * 4. identity: publishing the document back changes no identity of
 *    CommCare HQ's source;
 * 5. summary: the document says what CommCare HQ's own question summary of
 *    the source says.
 *
 * `acceptReadingSteps` is the same judge one piece at a time: it stops
 * between pieces (each choice's gate, each document's emission, each stage of
 * a re-read) until it is resumed, so a request can let the event loop turn.
 *
 * Pure: it reads its argument and module constants, logs nothing, reads no
 * store and no clock, and never throws for content: a production function
 * that throws over the document is a difference of the check that called it,
 * named by that function. A failure after a clean read is Nova's own
 * (`read-back-differs`), but for an unsettled hand-off, which is
 * `unrecognized`. Each difference's `detail` holds the app's words for a
 * developer and a test; its signature holds none.
 */
import "server-only";

import { Immer } from "immer";
import type { HqAlignedModule } from "@/lib/commcare/hq/appReading";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { publishedCaseBlocks } from "@/lib/commcare/hq/publishedCaseBlocks";
import {
	knownCaseTypesOf,
	knownLanguageCodesOf,
	type ReadDraft,
	type ReaderInput,
	type ReadOutcome,
	readHqAppSteps,
} from "@/lib/commcare/reader";
import {
	matchingResolver,
	mintingResolver,
} from "@/lib/commcare/reader/identity";
import { externalIdentityMap } from "@/lib/commcare/reader/identityMap";
import { placeOrder } from "@/lib/commcare/reader/place";
import type {
	ValidationError,
	ValidationLocation,
} from "@/lib/commcare/validator/errors";
import type { WireIdentity } from "@/lib/commcare/wireIdentity";
import {
	exportReadinessFindings,
	mutationCommitVerdict,
} from "@/lib/doc/commitVerdicts";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import type { DeclarationChoices } from "@/lib/doc/platformDeclaration";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type { Platform } from "@/lib/domain/platforms";
import { exportCarrierFindings } from "@/lib/export/boundaryFindings";
import type { LookupFixtureDataSnapshot } from "@/lib/lookup/types";
import type { FirstPublishView } from "@/lib/publish/firstPublishChangeIds";
import {
	circumstanceFinding,
	type Finding,
	type HqPlace,
} from "@/lib/publish/hqFindings";
import type { AdoptedMediaFile } from "../adoption";
import type { DeploymentTargetKey } from "../store";
import {
	alignedFromEmission,
	readingEmission,
	readingEmissionOptions,
	sourceFromEmission,
} from "./emission";
import {
	firstPublishChangesFor,
	firstPublishFactsOf,
} from "./firstPublishChanges";
import { fixedPointDifferences } from "./fixedPoint";
import { identityDifferences, sourceApplication } from "./identityAgreement";
import type { HandOffSettlement } from "./projectData/settlements";
import { differenceSignature, documentPathKinds } from "./signature";
import { sourcePlaces } from "./sourcePlaces";
import { summaryDifferences } from "./summaryAgreement";

export const ACCEPTANCE_CHECKS = [
	"accounting",
	"gate",
	"fixed-point",
	"identity",
	"summary",
] as const;
export type AcceptanceCheck = (typeof ACCEPTANCE_CHECKS)[number];

/** Applies a choice's mutations to a copy of the reading's document, which stays as it came. */
const UNFROZEN = new Immer({ autoFreeze: false });

/** At most this many differences are kept, and at most this many findings given. */
export const ACCEPTANCE_DIFFERENCES_KEPT = 20;

export interface AcceptReadingInput {
	/** The app's id, derived from the reading's id. */
	readonly appId: string;
	/** The project space the app was read from, as a publish names one. */
	readonly target: DeploymentTargetKey;
	readonly source: HqAppSource;
	readonly modules: readonly HqAlignedModule[];
	/** The reader's answer. Acceptance is called only where the reader read clean. */
	readonly outcome: Extract<ReadOutcome, { readonly kind: "read" }>;
	/** Everything of the reader's input but the source, the menus, the app id and the resolver:
	 *  the re-read of the fixed point is given exactly these. */
	readonly reader: Pick<
		ReaderInput,
		| "target"
		| "lookup"
		| "organization"
		| "media"
		| "appStrings"
		| "recordDialect"
		| "saveOnlyEditedApplied"
	>;
	/**
	 * The declarations to judge and to offer: the draft's, less each choice
	 * that declares a platform a held file does not play on, the proposal moved
	 * as `narrowDeclarationsByMedia` moves it. The caller ends the reading
	 * itself where none is left.
	 */
	readonly choices: Extract<DeclarationChoices, { readonly kind: "choices" }>;
	readonly settlements: readonly HandOffSettlement[];
	/**
	 * The tables the document reads, as the birth will hold them
	 * (`readingLookupSnapshot`): the bound tables under the reading's ids,
	 * their rows in order, and the Project's id and revision. Empty where the
	 * document reads no table.
	 */
	readonly lookup: LookupFixtureDataSnapshot;
	/** Media references with no file, left out. */
	readonly mediaLeftOut: number;
	/**
	 * Every referenced file, held and judged before acceptance is called.
	 * `rows` is the map `exportReadinessFindings` takes as its third argument
	 * (`readingMediaRows`).
	 */
	readonly media: {
		readonly files: readonly AdoptedMediaFile[];
		readonly rows: Parameters<typeof exportReadinessFindings>[2];
	};
}

export interface AcceptedDeclaration {
	/** Null is Web Apps and Android. */
	readonly runsOnlyOn: Platform | null;
	readonly splitDatetime: boolean;
	readonly preselected: boolean;
	/** The choice's own mutations, which follow the construction batch at the birth. */
	readonly mutations: readonly Mutation[];
	/** What a first publish changes where this choice is made. */
	readonly firstPublish: FirstPublishView;
}

/** Something acceptance found, for a developer and a test. Never stored, never logged. */
export interface AcceptanceDifference {
	readonly check: AcceptanceCheck;
	readonly signature: string;
	readonly place: HqPlace;
	/** What differs, in the app's own words. This string never leaves the process. */
	readonly detail: string;
}

export type AcceptedReading =
	| {
			readonly ok: true;
			/** One per choice of `input.choices`, in its order. */
			readonly declarations: readonly AcceptedDeclaration[];
			/** The preselected declaration's list. */
			readonly firstPublish: FirstPublishView;
			readonly sourceHoldsSaveToCase: boolean;
	  }
	| {
			readonly ok: false;
			readonly check: AcceptanceCheck;
			/** Content-free, at most 80 characters: the first difference's. */
			readonly signature: string;
			/** One finding per place, in `placeOrder`; at most 20. */
			readonly findings: readonly Finding[];
			readonly differences: readonly AcceptanceDifference[];
	  };

/**
 * The place of the entity a validation location names, in CommCare HQ's
 * source: a field at its authored path in its form, a form by its `xmlns`, a
 * menu by its id, each through the reading's identities, and the app where
 * none is named or the reading did not mint the uuid. The names are the
 * source's own.
 */
export function placeOfLocation(
	location: ValidationLocation,
	identities: ReadDraft["identities"],
	source: HqAppSource,
): HqPlace {
	const places = sourcePlaces(source);
	if (location.fieldUuid !== undefined) {
		const entry = identities.entries.find(
			(one) => one.kind === "field" && one.uuid === location.fieldUuid,
		);
		const [xmlns, path] = entry?.parts ?? [];
		if (typeof xmlns === "string" && Array.isArray(path))
			return places.questionAt(
				xmlns,
				path.filter((step): step is string => typeof step === "string"),
			);
	}
	if (location.formUuid !== undefined) {
		const form = identities.forms.find((one) => one.uuid === location.formUuid);
		if (form !== undefined) return places.formOf(form.xmlns);
	}
	if (location.moduleUuid !== undefined) {
		const menu = identities.modules.find(
			(one) => one.uuid === location.moduleUuid,
		);
		if (menu !== undefined) return places.menuOfId(menu.uniqueId);
	}
	return places.app;
}

/** A thrown production function, as the difference of the check that called it. */
class Threw extends Error {
	constructor(
		readonly fn: string,
		readonly cause: unknown,
	) {
		super(`${fn} threw`);
	}
}

/** `run()`, or a `Threw` that names `fn` where it throws. */
function calling<T>(fn: string, run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof Threw) throw error;
		throw new Threw(fn, error);
	}
}

/** `steps` run to their end, or a `Threw` that names `fn` where they throw. */
function* callingSteps<T>(fn: string, steps: Steps<T>): Steps<T> {
	try {
		return yield* steps;
	} catch (error) {
		if (error instanceof Threw) throw error;
		throw new Threw(fn, error);
	}
}

/** The pieces of acceptance: each `yield` is a place it may stop. */
type Steps<T> = Generator<void, T, void>;

function thrownDetail(error: Threw): string {
	return error.cause instanceof Error
		? error.cause.message
		: String(error.cause);
}

/** One choice that passed the gate, with the document it gives. */
interface Gated {
	readonly choice: AcceptReadingInput["choices"]["choices"][number];
	readonly index: number;
	readonly doc: BlueprintDoc;
}

export function acceptReading(input: AcceptReadingInput): AcceptedReading {
	const steps = acceptReadingSteps(input);
	for (;;) {
		const step = steps.next();
		if (step.done) return step.value;
	}
}

export function* acceptReadingSteps(
	input: AcceptReadingInput,
): Steps<AcceptedReading> {
	const { outcome, source } = input;
	const draft = outcome.draft;
	const places = sourcePlaces(source);
	const placeOf = (location: ValidationLocation): HqPlace =>
		placeOfLocation(location, draft.identities, source);
	const difference = (
		check: AcceptanceCheck,
		segments: readonly string[],
		place: HqPlace,
		detail: string,
	): AcceptanceDifference => ({
		check,
		signature: differenceSignature(check, segments),
		place,
		detail,
	});
	const threw = (
		check: AcceptanceCheck,
		error: unknown,
		lead: readonly string[] = [],
	): AcceptanceDifference[] => {
		if (!(error instanceof Threw)) throw error;
		return [
			difference(
				check,
				[...lead, "threw", error.fn],
				places.app,
				thrownDetail(error),
			),
		];
	};

	// 1. Accounting.
	const accounting = accountingDifferences(input, difference);
	if (accounting.differences.length > 0)
		return failed("accounting", accounting.differences, accounting.findings);

	// 2. The gate and the export readiness of a first publish, per choice.
	const lookupContext: LookupValidationContext = {
		kind: "available",
		projectId: input.lookup.projectId,
		projectRevision: input.lookup.projectRevision,
		definitions: input.lookup.definitions,
	};
	const gated: Gated[] = [];
	const gate: AcceptanceDifference[] = [];
	for (const [index, choice] of input.choices.choices.entries()) {
		yield;
		try {
			const verdict = calling("mutationCommitVerdict", () =>
				mutationCommitVerdict(
					emptyBlueprintDoc(input.appId),
					[...draft.batch, ...choice.mutations],
					lookupContext,
				),
			);
			if (!verdict.ok) {
				for (const finding of verdict.findings)
					gate.push(
						gateDifference(difference, [finding.code], finding, placeOf),
					);
				continue;
			}
			const doc = verdict.nextDoc;
			yield;
			const readiness = calling("exportReadinessFindings", () =>
				exportReadinessFindings(doc, lookupContext, input.media.rows),
			);
			const carrier = calling("exportCarrierFindings", () => {
				const found = exportCarrierFindings({
					doc,
					mode: "hq-upload",
					fixtureData: input.lookup,
					lookupTarget: input.target,
				});
				return [...found.rowFindings, ...found.selectionFindings];
			});
			const exportFindings = [...readiness, ...carrier];
			for (const finding of exportFindings)
				gate.push(
					gateDifference(
						difference,
						["export", finding.code],
						finding,
						placeOf,
					),
				);
			if (exportFindings.length === 0) gated.push({ choice, index, doc });
		} catch (error) {
			gate.push(...threw("gate", error));
		}
	}
	if (gate.length > 0) return failed("gate", gate);

	// 3. The fixed point: D, then the split document where a choice offers it.
	const fixedPoint = yield* fixedPointCheck(input, gated, placeOf, threw);
	if (!("emission" in fixedPoint))
		return failed("fixed-point", fixedPoint.differences);
	const emission = fixedPoint.emission;

	// 4. Identity agreement between CommCare HQ's source and that emission.
	yield;
	let identity: ReturnType<typeof identityDifferences>;
	try {
		identity = calling("identityDifferences", () =>
			identityDifferences({
				source,
				emission,
				draft,
				attachmentTarget: input.reader.target,
			}),
		);
	} catch (error) {
		return failed("identity", threw("identity", error));
	}
	if (identity.differences.length > 0)
		return failed("identity", identity.differences);

	// 5. CommCare HQ's own question summary against the document.
	yield;
	let summary: readonly AcceptanceDifference[];
	try {
		summary = calling("summaryDifferences", () =>
			summaryDifferences({
				source,
				modules: input.modules,
				draft,
				sourceIdentity: identity.sourceIdentity,
			}),
		);
	} catch (error) {
		summary = threw("summary", error);
	}
	if (summary.length > 0) return failed("summary", summary);

	// What a first publish changes, per choice, from that choice's own document.
	const forms = draft.facts.forms.flatMap((form) => {
		const found = draft.identities.forms.find(
			(one) => one.xmlns === form.xmlns,
		);
		return found === undefined ? [] : [{ uuid: found.uuid }];
	});
	const declarations: AcceptedDeclaration[] = [];
	for (const { choice, index, doc } of gated) {
		yield;
		try {
			const runsOnlyOn = choice.runsOnlyOn ?? null;
			const firstPublish = calling("firstPublishChangesFor", () =>
				firstPublishChangesFor(
					firstPublishFactsOf({
						source,
						doc,
						facts: draft.facts,
						forms,
						attachmentTarget: input.reader.target,
						mediaFiles: input.media.files,
						mediaLeftOut: input.mediaLeftOut,
						choice: { runsOnlyOn, split: choice.split },
					}),
				),
			);
			declarations.push({
				runsOnlyOn,
				splitDatetime: choice.split,
				preselected: index === input.choices.proposed,
				mutations: choice.mutations,
				firstPublish,
			});
		} catch (error) {
			return failed("gate", threw("gate", error));
		}
	}
	const preselected =
		declarations.find((one) => one.preselected) ?? declarations[0];
	if (preselected === undefined)
		return failed("gate", [
			difference(
				"gate",
				["no-choice"],
				places.app,
				"no declaration choice was handed to acceptance",
			),
		]);
	return {
		ok: true,
		declarations,
		firstPublish: preselected.firstPublish,
		sourceHoldsSaveToCase: [
			...publishedCaseBlocks(sourceApplication(source)).forms.values(),
		].some((form) =>
			form.blocks.some((block) => block.kind === "save-to-case"),
		),
	};
}

function gateDifference(
	difference: (
		check: AcceptanceCheck,
		segments: readonly string[],
		place: HqPlace,
		detail: string,
	) => AcceptanceDifference,
	segments: readonly string[],
	finding: ValidationError,
	placeOf: (location: ValidationLocation) => HqPlace,
): AcceptanceDifference {
	return difference(
		"gate",
		segments,
		placeOf(finding.location),
		finding.message,
	);
}

/**
 * Check 1. Every defect beside a clean outcome contradicts the reader's own
 * contract. Every hand-off is settled exactly once by its `artifact`,
 * `where` and `key`: one no settlement names is `unrecognized`, as the
 * reader's own close words a use nothing read, at the place of the media
 * reference or table read whose path or tag is its subject; one settled
 * twice, and a settlement of no hand-off, contradict project data's
 * contract.
 */
function accountingDifferences(
	input: AcceptReadingInput,
	difference: (
		check: AcceptanceCheck,
		segments: readonly string[],
		place: HqPlace,
		detail: string,
	) => AcceptanceDifference,
): {
	readonly differences: readonly AcceptanceDifference[];
	readonly findings: readonly Finding[];
} {
	const { outcome } = input;
	const facts = outcome.draft.facts;
	const app = sourcePlaces(input.source).app;
	const differences: AcceptanceDifference[] = [];
	const findings: Finding[] = [];
	for (const defect of outcome.defects) {
		differences.push(
			difference("accounting", ["defect"], defect.place, defect.name),
		);
		findings.push(
			circumstanceFinding("read-back-differs", defect.place, {
				name: "accounting",
			}),
		);
	}
	const keyOf = (one: {
		readonly artifact: string;
		readonly where: string;
		readonly key: string;
	}) => JSON.stringify([one.artifact, one.where, one.key]);
	const settled = new Map<string, number>();
	for (const settlement of input.settlements)
		settled.set(keyOf(settlement), (settled.get(keyOf(settlement)) ?? 0) + 1);
	const handed = new Set<string>();
	for (const handOff of outcome.claims.handOffs) {
		const key = keyOf(handOff);
		handed.add(key);
		const place =
			facts.pendingMedia.find((one) => one.path === handOff.subject)?.place ??
			facts.unreadTables.find((one) => one.tag === handOff.subject)?.place ??
			app;
		const count = settled.get(key) ?? 0;
		if (count === 1) continue;
		if (count === 0) {
			differences.push(
				difference(
					"accounting",
					["hand-off-unsettled", handOff.to],
					place,
					`${handOff.subject} at ${handOff.where} is settled by nothing`,
				),
			);
			findings.push(
				circumstanceFinding("unrecognized", place, { name: handOff.key }),
			);
		} else {
			differences.push(
				difference(
					"accounting",
					["hand-off-settled-twice", handOff.to],
					place,
					`${handOff.subject} at ${handOff.where} is settled ${count} times`,
				),
			);
			findings.push(
				circumstanceFinding("read-back-differs", place, { name: "accounting" }),
			);
		}
	}
	for (const settlement of input.settlements)
		if (!handed.has(keyOf(settlement))) {
			differences.push(
				difference(
					"accounting",
					["settlement-unmatched"],
					app,
					`a settlement of ${settlement.key} at ${settlement.where} matches no hand-off`,
				),
			);
			findings.push(
				circumstanceFinding("read-back-differs", app, { name: "accounting" }),
			);
		}
	return { differences, findings };
}

/**
 * Check 3. D's emission is re-read and must give D; where a choice offers
 * the split, the split document (the reading's document under that
 * choice's mutations, with no declaration, since the reader writes none
 * into the document) is emitted and re-read under a resolver matching its own
 * identities, so the questions the split made keep their uuids. D first: a
 * difference there ends the check.
 */
function* fixedPointCheck(
	input: AcceptReadingInput,
	gated: readonly Gated[],
	placeOf: (location: ValidationLocation) => HqPlace,
	threw: (
		check: AcceptanceCheck,
		error: unknown,
		lead?: readonly string[],
	) => AcceptanceDifference[],
): Steps<
	| {
			readonly differences: readonly [];
			readonly emission: ReturnType<typeof readingEmission>;
	  }
	| { readonly differences: readonly AcceptanceDifference[] }
> {
	const { outcome, source } = input;
	const draft = outcome.draft;
	const emitted = (doc: BlueprintDoc) => ({
		doc,
		source,
		draft,
		reader: input.reader,
		lookupDefinitions: input.lookup.definitions,
		files: input.media.files,
	});
	const reRead = (
		doc: BlueprintDoc,
		emission: ReturnType<typeof readingEmission>,
		resolver: ReaderInput["resolver"],
	) =>
		callingSteps(
			"readHqApp",
			readHqAppSteps({
				appId: input.appId,
				target: input.reader.target,
				source: sourceFromEmission(emission, source),
				modules: alignedFromEmission(emission),
				resolver,
				lookup: input.reader.lookup,
				organization: input.reader.organization,
				media: input.reader.media,
				appStrings: input.reader.appStrings,
				recordDialect: input.reader.recordDialect,
				...(input.reader.saveOnlyEditedApplied !== undefined && {
					saveOnlyEditedApplied: input.reader.saveOnlyEditedApplied,
				}),
				knownCaseTypes: knownCaseTypesOf(doc),
				knownLanguageCodes: knownLanguageCodesOf(doc),
			}),
		);
	const naming = {
		placeOf,
		signature: (segments: readonly string[]) =>
			differenceSignature("fixed-point", segments),
		pathKinds: documentPathKinds,
	};

	let emission: ReturnType<typeof readingEmission>;
	try {
		emission = calling("readingEmission", () =>
			readingEmission(emitted(draft.doc)),
		);
		yield;
		const again = yield* reRead(
			draft.doc,
			emission,
			mintingResolver(input.appId),
		);
		const found = fixedPointDifferences(draft.doc, again, { outcome }, naming);
		if (found.length > 0) return { differences: found };
	} catch (error) {
		return { differences: threw("fixed-point", error) };
	}

	const split = gated.find((one) => one.choice.split);
	if (split !== undefined) {
		yield;
		try {
			const under = calling("applyMutations", () =>
				UNFROZEN.produce(draft.doc, (working) => {
					applyMutations(working, split.choice.mutations);
				}),
			);
			const { runsOnlyOn: _declared, ...settings } = under.appSettings;
			const expected: BlueprintDoc = { ...under, appSettings: settings };
			const options = calling("readingEmissionOptions", () =>
				readingEmissionOptions(emitted(expected)),
			);
			const identity = options.identity as WireIdentity;
			const splitEmission = calling("readingEmission", () =>
				readingEmission(emitted(expected)),
			);
			yield;
			const again = yield* reRead(
				expected,
				splitEmission,
				matchingResolver(
					input.appId,
					calling("externalIdentityMap", () =>
						externalIdentityMap(expected, identity),
					),
				),
			);
			const found = fixedPointDifferences(
				expected,
				again,
				{ outcome },
				naming,
				{ split: true },
			);
			if (found.length > 0) return { differences: found };
		} catch (error) {
			return { differences: threw("fixed-point", error, ["split"]) };
		}
	}
	return { differences: [], emission };
}

/**
 * The failing arm: the check, the first difference's signature, the first
 * twenty differences, and one finding per place in `placeOrder`, at most
 * twenty. A check's findings are `read-back-differs` named by the check,
 * where `findings` is not given.
 */
function failed(
	check: AcceptanceCheck,
	differences: readonly AcceptanceDifference[],
	findings?: readonly Finding[],
): Extract<AcceptedReading, { readonly ok: false }> {
	const given =
		findings ??
		differences.map((one) =>
			circumstanceFinding("read-back-differs", one.place, { name: check }),
		);
	const distinct = new Map<string, Finding>();
	for (const finding of given)
		distinct.set(
			JSON.stringify([finding.code, finding.place, finding.detail]),
			finding,
		);
	return {
		ok: false,
		check,
		signature: differences[0]?.signature ?? check,
		findings: [...distinct.values()]
			.sort((a, b) => placeOrder(a.place, b.place))
			.slice(0, ACCEPTANCE_DIFFERENCES_KEPT),
		differences: differences.slice(0, ACCEPTANCE_DIFFERENCES_KEPT),
	};
}
