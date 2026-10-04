/**
 * The edit-batch generator for the proof corpus.
 *
 * Every corpus document comes with one edit batch, so the harness can publish
 * a document D, then publish D′ (D after the batch) over it, and compare what
 * HQ holds. A batch is drawn from one mutation kind the reducer defines
 * (`./editKinds.ts`), targets entities of D, and is kept only when
 *
 * - the real commit gate (`lib/doc/commitVerdicts.ts::mutationCommitVerdict`)
 *   admits it against D, under D's own lookup context, so D′ is exactly the
 *   document the gate validated (`verdict.nextDoc`) and the batch is exactly
 *   the canonical one it admitted (`verdict.mutations`);
 * - D′ differs from D (a batch that leaves D as it was is a publish with no
 *   edit, which the harness already makes); and
 * - D′ passes the checks Nova's direct HQ upload applies beyond the commit
 *   gate (`publishFindings` below), so every kept D′ is a document Nova's
 *   publish accepts.
 *
 * `editBatchCorpus` balances kinds across a corpus's fixed documents so that
 * every kind they can take lands on one of them, gives each sampled document
 * the batch it would get on its own, and reports each kind's census:
 * candidates, tries with no target, refusals by code, admissions and share of
 * the admitted mutations.
 */

import { isDeepStrictEqual } from "node:util";
import { produce } from "immer";
import { hqNestedSelectionFindings } from "@/lib/commcare/hqNestedSelection";
import { lookupHqCellTextFindings } from "@/lib/commcare/lookup/hqCellText";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { lookupSelectSourceRowFindings } from "@/lib/commcare/lookup/selectSourceRows";
import { lookupXmlTextFindings } from "@/lib/commcare/lookup/xmlText";
import {
	type ValidationError,
	validationError,
} from "@/lib/commcare/validator/errors";
import { evaluateBoundary } from "@/lib/commcare/validator/gate";
import { runValidation } from "@/lib/commcare/validator/runner";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import {
	extractLookupReferenceTargets,
	PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
} from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import {
	ensureReferenceIndex,
	planReferenceIndexMaintenance,
	referencingCarrierUuids,
} from "@/lib/doc/referenceIndex";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type EntryPointTarget,
	entityTargetKey,
	entryPointByUuid,
	iconCatalogEntry,
	type PersistableDoc,
	parseBuiltinIconSlug,
	type Uuid,
} from "@/lib/domain";
import { type MediaSlotKind, walkAssetRefs } from "@/lib/domain/mediaRefs";
import type { LookupFixtureDataSnapshot } from "@/lib/lookup/types";
import { exportBudgetExcess } from "@/lib/media/exportBudget";
import { lookupContextOf } from "./documents";
import {
	Minter,
	mintFreshIdentities,
	Rng,
	stableHash,
	uuidTokensOf,
} from "./editContext";
import {
	type Candidate,
	EDIT_KIND_GENERATORS,
	EDIT_KINDS,
	type GenContext,
} from "./editKinds";

export { EDIT_KINDS } from "./editKinds";

export type MutationKind = Mutation["kind"];

/** One admitted corpus document the generator edits. */
export interface EditCorpusDocument {
	/** Stable identity: the corpus source plus its sample index or name. */
	readonly id: string;
	/** The stored document; it must parse under the strict schema. */
	readonly doc: PersistableDoc;
	/**
	 * The Project lookup data the document is validated and published with:
	 * every table it may reference, with complete rows. Absent for a
	 * document that references none.
	 */
	readonly lookup?: LookupFixtureDataSnapshot;
}

/** The edit a corpus document carries, and what it leaves. */
export interface KeptEditBatch {
	readonly documentId: string;
	readonly seed: number;
	/** The kind the batch was drawn for. */
	readonly intendedKind: MutationKind;
	/** The canonical batch the commit gate admitted. */
	readonly mutations: readonly Mutation[];
	/** D′: exactly the document the commit gate validated. */
	readonly nextDoc: BlueprintDoc;
	/** Each mutation's kind, in batch order. */
	readonly kinds: readonly MutationKind[];
	/**
	 * The entities the batch's mutations touch, each mutation read on the
	 * state just before it: the carriers the reference index re-extracts for
	 * it (`planReferenceIndexMaintenance`: modules, forms, fields,
	 * automations, personas, organization levels and place properties), plus
	 * what the index keeps no carrier for: an entry point with the module or
	 * form that hosts it, and a worker-information property or role.
	 *
	 * The kinds that change app-level state (the app's name, logo and Connect
	 * type, its languages and translations, the case-type catalog) record no
	 * entity here, and the entities that read a touched one are not listed:
	 * this is not the footprint a locality check compares outside of.
	 */
	readonly touched: readonly Uuid[];
	/** Whether the reference index names a reader of a touched entity. */
	readonly hasReaders: boolean;
}

/** One kind tried on one document. */
export interface KindAttempt {
	readonly kind: MutationKind;
	/** Batches proposed (a planner refusal counts as a proposal). */
	readonly candidates: number;
	/**
	 * Every refusal: a commit-gate finding code, or `planner:` (the
	 * production planner refused to compose it), `no-op` (the gate admitted
	 * a batch that leaves the document as it was), `publish:` (a check Nova's
	 * publish applies beyond the gate) or `threw:` (Nova raised an error).
	 */
	readonly refusals: readonly string[];
	/**
	 * Errors Nova raised while this kind was planned or judged, instead of
	 * returning a plan or a verdict: Nova defects the corpus reached.
	 */
	readonly errors: readonly string[];
	/** Whether a candidate was admitted, so it is the document's batch. */
	readonly admitted: boolean;
}

export interface EditBatchOutcome {
	readonly documentId: string;
	/** Absent when no tried kind produced an admitted batch. */
	readonly batch?: KeptEditBatch;
	readonly attempts: readonly KindAttempt[];
}

// ── The publish-side checks ──────────────────────────────────────────

const MEDIA_MIME: Record<
	MediaSlotKind,
	{ mimeType: MediaAssetRecord["mimeType"]; extension: string }
> = {
	image: { mimeType: "image/png", extension: ".png" },
	audio: { mimeType: "audio/wav", extension: ".wav" },
	video: { mimeType: "video/mp4", extension: ".mp4" },
};

function readyRow(
	id: string,
	kind: MediaSlotKind,
	fields: { sizeBytes: number; contentHash: string },
): MediaAssetRecord {
	const { mimeType, extension } = MEDIA_MIME[kind];
	return {
		id: id as MediaAssetRecord["id"],
		project_id: "proof-corpus",
		owner: "proof-corpus",
		contentHash: fields.contentHash,
		mimeType,
		extension,
		sizeBytes: fields.sizeBytes,
		kind,
		gcsObjectKey: "",
		originalFilename: `asset${extension}`,
		status: "ready",
		created_at: new Date(0),
	};
}

/**
 * The media rows a publish resolves for the document, split the way the
 * export boundary splits references
 * (`lib/media/builtinIconAssets.ts::partitionAssetRefs`): a built-in icon
 * resolves to its catalog image (`builtinAssetRows`), and every other
 * reference to one ready uploaded asset of the kind of the first slot that
 * holds it. The corpus producers upload their media the same way (one asset
 * per slot kind), so an uploaded id held by slots of two kinds is refused
 * here as `MEDIA_KIND_MISMATCH`, exactly as the export boundary would refuse
 * it. An uploaded asset stands in at one byte: the producers' media are a
 * few hundred bytes each, far under the byte budget.
 */
function mediaRowsFor(doc: BlueprintDoc): Map<string, MediaAssetRecord> {
	const rows = new Map<string, MediaAssetRecord>();
	for (const ref of walkAssetRefs(doc)) {
		if (rows.has(ref.assetId)) continue;
		const slug = parseBuiltinIconSlug(ref.assetId);
		const builtin = slug === null ? undefined : iconCatalogEntry(slug);
		rows.set(
			ref.assetId,
			builtin === undefined
				? readyRow(ref.assetId, ref.slotKind, { sizeBytes: 1, contentHash: "" })
				: readyRow(ref.assetId, "image", builtin),
		);
	}
	return rows;
}

/** The media export budget (`lib/media/exportBudget.ts::exportBudgetExcess`). */
function mediaBudgetFindings(
	rows: ReadonlyMap<string, MediaAssetRecord>,
): ValidationError[] {
	const excess = exportBudgetExcess([...rows.values()]);
	if (excess === null) return [];
	return [
		validationError(
			"MEDIA_EXPORT_TOO_LARGE",
			"app",
			`Nova's publish would not send this app's media: ${excess.reasons.join(" and ")}.`,
			{},
		),
	];
}

/**
 * What publish reads from the Project's lookup data: only the tables the
 * document references (`lib/lookup/service.ts::getLookupFixtureData` is
 * called with exactly those ids).
 */
function referencedLookupData(
	doc: BlueprintDoc,
	lookup: LookupFixtureDataSnapshot,
): LookupFixtureDataSnapshot {
	const tableIds = new Set<string>(
		extractLookupReferenceTargets(doc, PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS)
			.tableIds,
	);
	return {
		projectId: lookup.projectId,
		projectRevision: lookup.projectRevision,
		definitions: lookup.definitions.filter((d) => tableIds.has(d.id)),
		rowsByTable: new Map(
			[...lookup.rowsByTable].filter(([id]) => tableIds.has(id)),
		),
	};
}

/**
 * The findings Nova's direct HQ upload
 * (`lib/export/boundaryValidation.ts::prepareExportBoundary`, mode
 * `hq-upload`) returns for a document, through Nova's own exported checks:
 * the complete validator with the media rows, the media export budget, the
 * lookup row and text checks over the referenced tables, and the HQ
 * nested-selection check.
 *
 * Some checks of that boundary are private to `boundaryValidation.ts` and
 * are not run here: `organizationExportFindings` (a case owner fixed to one
 * place), `lookupHqSheetNameFindings` and `lookupHqReservedTagFindings` (a
 * referenced table's tag) and `lookupWorkbookBudgetFindings` (the workbook's
 * row total). The generator never authors a fixed-place owner. An edit that
 * newly references a Project table has that table's rows and text checked
 * here, but not its tag or the workbook total.
 */
export function publishFindings(
	doc: BlueprintDoc,
	lookup: LookupFixtureDataSnapshot | undefined,
): ValidationError[] {
	const referenced =
		lookup === undefined ? undefined : referencedLookupData(doc, lookup);
	const media = mediaRowsFor(doc);
	const findings = [
		...evaluateBoundary(doc, media, lookupContextOf(referenced)),
		...mediaBudgetFindings(media),
		...(referenced === undefined
			? []
			: [
					...lookupXmlTextFindings(referenced),
					...lookupHqCellTextFindings(referenced),
					...lookupSelectSourceRowFindings(doc, referenced),
				]),
	];
	if (findings.length > 0) return findings;
	return hqNestedSelectionFindings(
		doc,
		"hq-upload",
		referenced === undefined || referenced.definitions.length === 0
			? undefined
			: lookupWireNaming(referenced.definitions),
	);
}

// ── Admission ────────────────────────────────────────────────────────

/**
 * Hydrate an admitted corpus document exactly as Nova's load boundary does
 * (`hydratePersistedBlueprint` over the strict-schema parse, then the
 * reference index), refusing one that is not admitted and publishable.
 */
export function hydrateAdmittedDocument(
	input: EditCorpusDocument,
): BlueprintDoc {
	const parsed = blueprintDocSchema.safeParse(input.doc);
	if (!parsed.success) {
		throw new Error(
			`Corpus document ${input.id} does not parse under Nova's strict blueprint schema, so it cannot be edited: ${parsed.error.message}`,
		);
	}
	const doc = hydratePersistedBlueprint(parsed.data);
	ensureReferenceIndex(doc);
	const findings = runValidation(doc, lookupContextOf(input.lookup));
	if (findings.length > 0) {
		throw new Error(
			`Corpus document ${input.id} is not admitted: full validation reports ${findings.map((f) => f.code).join(", ")}. Every corpus document must pass validation before it gets an edit batch.`,
		);
	}
	const publish = publishFindings(doc, input.lookup);
	if (publish.length > 0) {
		throw new Error(
			`Corpus document ${input.id} is admitted but Nova's publish would refuse it (${publish.map((f) => f.code).join(", ")}), so it has no place in the corpus.`,
		);
	}
	return doc;
}

/** A corpus document ready to be edited. */
interface PreparedDocument {
	readonly input: EditCorpusDocument;
	/** D, hydrated, its reference index built. */
	readonly doc: BlueprintDoc;
	/**
	 * Identities an edit may name without minting them: the document's own,
	 * and the Project lookup tables, columns and rows it can be pointed at.
	 */
	readonly known: ReadonlySet<string>;
	/** D as stored, in JSON form: what a batch that changes nothing leaves. */
	readonly stored: unknown;
}

/** A stored document in JSON form, so equal content compares equal. */
function storedJson(doc: BlueprintDoc): unknown {
	return JSON.parse(JSON.stringify(toPersistableDoc(doc)));
}

function prepareDocument(input: EditCorpusDocument): PreparedDocument {
	const doc = hydrateAdmittedDocument(input);
	return {
		input,
		doc,
		known: new Set([
			...uuidTokensOf(input.doc),
			...uuidTokensOf(input.lookup?.definitions ?? []),
			...uuidTokensOf([...(input.lookup?.rowsByTable.values() ?? [])]),
		]),
		stored: storedJson(doc),
	};
}

export type EditBatchVerdict =
	| {
			readonly ok: true;
			readonly mutations: readonly Mutation[];
			readonly nextDoc: BlueprintDoc;
	  }
	| {
			readonly ok: false;
			readonly codes: readonly string[];
			/** Set when Nova raised an error instead of returning a verdict. */
			readonly error?: string;
	  };

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The commit gate's verdict on the batch, then whether it changed anything,
 * then the publish checks on the document it admits. The gate and the
 * checks are total functions of the document in Nova; an error either
 * raises is a Nova defect the corpus reached, recorded as such rather than
 * counted as an admission or a finding.
 */
function judge(
	prepared: PreparedDocument,
	mutations: readonly Mutation[],
): EditBatchVerdict {
	const { doc, input } = prepared;
	let verdict: ReturnType<typeof mutationCommitVerdict>;
	try {
		verdict = mutationCommitVerdict(
			doc,
			mutations,
			lookupContextOf(input.lookup),
		);
	} catch (error) {
		return { ok: false, codes: ["threw:commit-gate"], error: errorText(error) };
	}
	if (!verdict.ok) {
		return {
			ok: false,
			codes: [...new Set(verdict.findings.map((f) => f.code))],
		};
	}
	if (isDeepStrictEqual(storedJson(verdict.nextDoc), prepared.stored)) {
		return { ok: false, codes: ["no-op"] };
	}
	let publish: ValidationError[];
	try {
		publish = publishFindings(verdict.nextDoc, input.lookup);
	} catch (error) {
		return { ok: false, codes: ["threw:publish"], error: errorText(error) };
	}
	if (publish.length > 0) {
		return {
			ok: false,
			codes: [...new Set(publish.map((f) => `publish:${f.code}`))],
		};
	}
	return { ok: true, mutations: verdict.mutations, nextDoc: verdict.nextDoc };
}

/**
 * Judge one batch against a corpus document exactly as the generator keeps
 * one: the commit gate under the document's lookup context, the refusal of a
 * batch that changes nothing, then the publish checks on the document it
 * admits.
 */
export function admitEditBatch(
	input: EditCorpusDocument,
	mutations: readonly Mutation[],
): EditBatchVerdict {
	return judge(prepareDocument(input), mutations);
}

function entryPointHost(target: EntryPointTarget): Uuid {
	return target.kind === "form" ? target.formUuid : target.moduleUuid;
}

/**
 * Entities a mutation names that the reference index keeps no carrier for:
 * an entry point and the module or form hosting it (read on the states
 * before and after the mutation, so a removed or retargeted one is found),
 * and a worker-information property or role.
 */
function uncarriedSubjects(
	mutation: Mutation,
	before: BlueprintDoc,
	after: BlueprintDoc,
): Uuid[] {
	switch (mutation.kind) {
		case "addEntryPoint":
			return [mutation.entryPoint.uuid, entryPointHost(mutation.target)];
		case "updateEntryPoint":
		case "removeEntryPoint":
			return [
				mutation.entryPointUuid,
				...[before, after].flatMap((state) => {
					const item = entryPointByUuid(state, mutation.entryPointUuid);
					return item === undefined ? [] : [entryPointHost(item.target)];
				}),
			];
		case "addUserProperty":
			return [mutation.property.uuid];
		case "addUserType":
			return [mutation.userType.uuid];
		case "updateUserProperty":
		case "removeUserProperty":
		case "updateUserType":
		case "removeUserType":
			return [mutation.uuid];
		default:
			return [];
	}
}

/** What each mutation touches, on the state just before it. */
function touchedEntities(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): Uuid[] {
	const touched = new Set<Uuid>();
	let state = doc;
	for (const mutation of mutations) {
		for (const carrier of planReferenceIndexMaintenance(state, mutation)
			.carriers) {
			touched.add(carrier as Uuid);
		}
		const next = produce(state, (draft) => {
			applyMutations(draft, [mutation]);
		});
		for (const uuid of uncarriedSubjects(mutation, state, next)) {
			touched.add(uuid);
		}
		state = next;
	}
	return [...touched];
}

function readersOf(
	before: BlueprintDoc,
	after: BlueprintDoc,
	touched: readonly Uuid[],
): boolean {
	const own = new Set<string>(touched);
	return touched.some((uuid) =>
		[before, after].some((doc) =>
			referencingCarrierUuids(doc, entityTargetKey(uuid)).some(
				(reader) => !own.has(reader),
			),
		),
	);
}

/**
 * An edit written by hand (a targeted document's own, `CorpusDocument.edit`)
 * as the batch the edit generator would have kept for it: the mutations
 * Nova's commit gate admitted from `doc` to `nextDoc`, each one's kind, what
 * each touches, and whether anything reads what they touch. The batch's
 * first mutation's kind stands as the kind it was drawn for.
 */
export function writtenEditBatch(
	documentId: string,
	seed: number,
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
	nextDoc: BlueprintDoc,
): KeptEditBatch {
	const [first] = mutations;
	if (first === undefined) {
		throw new Error(
			`The edit written for ${documentId} holds no mutation, so it edits nothing; write the document after the edit as it differs.`,
		);
	}
	const touched = touchedEntities(doc, mutations);
	return {
		documentId,
		seed,
		intendedKind: first.kind,
		mutations,
		nextDoc,
		kinds: mutations.map((mutation) => mutation.kind),
		touched,
		hasReaders: readersOf(doc, nextDoc, touched),
	};
}

/** A kind's proposals on one document, and the minter that drew them. */
interface Proposal {
	readonly kind: MutationKind;
	readonly mint: Minter;
	readonly candidates: readonly Candidate[];
	/** Set when a production planner raised instead of planning or refusing. */
	readonly error?: string;
}

/**
 * Propose one kind's candidates on one prepared document. The same document,
 * seed and kind always give the same proposal, whatever was proposed before.
 */
function proposeKind(
	prepared: PreparedDocument,
	seed: number,
	kind: MutationKind,
): Proposal {
	const { input, doc, known } = prepared;
	const mint = new Minter(`${input.id}\u0000${kind}`, seed);
	const ctx: GenContext = {
		doc,
		known,
		rng: new Rng(`${seed}\u0000${input.id}\u0000${kind}`),
		mint,
		...(input.lookup !== undefined && { lookup: input.lookup }),
	};
	try {
		return { kind, mint, candidates: EDIT_KIND_GENERATORS[kind](ctx) };
	} catch (error) {
		return { kind, mint, candidates: [], error: errorText(error) };
	}
}

/** Whether a proposal gives the gate anything to judge. */
function proposes(proposal: Proposal): boolean {
	return proposal.candidates.length > 0 || proposal.error !== undefined;
}

/**
 * Judge a proposal's candidates in order and keep the first one the commit
 * gate and the publish checks admit.
 */
function judgeProposal(
	prepared: PreparedDocument,
	seed: number,
	proposal: Proposal,
): { attempt: KindAttempt; batch?: KeptEditBatch } {
	const { input, doc, known } = prepared;
	const { kind, mint, candidates } = proposal;
	if (proposal.error !== undefined) {
		return {
			attempt: {
				kind,
				candidates: 0,
				refusals: ["threw:planner"],
				errors: [proposal.error],
				admitted: false,
			},
		};
	}
	const refusals: string[] = [];
	const errors: string[] = [];
	for (const candidate of candidates) {
		if ("refused" in candidate) {
			refusals.push(candidate.refused);
			continue;
		}
		const mutations = mintFreshIdentities(candidate.mutations, known, mint);
		const judged = judge(prepared, mutations);
		if (!judged.ok) {
			refusals.push(...judged.codes);
			if (judged.error !== undefined) errors.push(judged.error);
			continue;
		}
		const touched = touchedEntities(doc, judged.mutations);
		return {
			attempt: {
				kind,
				candidates: candidates.length,
				refusals,
				errors,
				admitted: true,
			},
			batch: {
				documentId: input.id,
				seed,
				intendedKind: kind,
				mutations: judged.mutations,
				nextDoc: judged.nextDoc,
				kinds: judged.mutations.map((m) => m.kind),
				touched,
				hasReaders: readersOf(doc, judged.nextDoc, touched),
			},
		};
	}
	return {
		attempt: {
			kind,
			candidates: candidates.length,
			refusals,
			errors,
			admitted: false,
		},
	};
}

/** Kinds that proposed a batch before a document is left without one. */
const DEFAULT_MAX_KINDS_PER_DOCUMENT = 12;

/** Every kind in an order fixed by the seed and the document's id alone. */
function seededKindOrder(seed: number, id: string): MutationKind[] {
	return [...EDIT_KINDS].sort(
		(a, b) =>
			stableHash(`${seed}\u0000${id}\u0000${a}`) -
			stableHash(`${seed}\u0000${id}\u0000${b}`),
	);
}

/**
 * Try kinds in order until one yields a kept batch. A kind with nothing to
 * target on the document costs nothing and does not count toward
 * `maxKinds`, which bounds the kinds that proposed a batch.
 */
function tryKinds(
	prepared: PreparedDocument,
	seed: number,
	order: readonly MutationKind[],
	maxKinds: number,
	propose: (kind: MutationKind) => Proposal = (kind) =>
		proposeKind(prepared, seed, kind),
): { batch?: KeptEditBatch; attempts: KindAttempt[] } {
	const attempts: KindAttempt[] = [];
	let proposing = 0;
	for (const kind of order) {
		if (proposing >= maxKinds) break;
		const proposal = propose(kind);
		const { attempt, batch } = judgeProposal(prepared, seed, proposal);
		attempts.push(attempt);
		if (batch !== undefined) return { batch, attempts };
		if (proposes(proposal)) proposing += 1;
	}
	return { attempts };
}

/**
 * Generate one edit batch for one admitted document.
 *
 * Kinds are tried in `kindOrder` (by default an order fixed by the seed and
 * the document's id) until one yields a kept batch, trying at most
 * `maxKinds` kinds that propose one (by default the corpus's per-document
 * bound). The same document, seed and options always give the same batch.
 */
export function editBatchFor(
	input: EditCorpusDocument,
	seed: number,
	options: {
		readonly kindOrder?: readonly MutationKind[];
		readonly maxKinds?: number;
	} = {},
): EditBatchOutcome {
	const { batch, attempts } = tryKinds(
		prepareDocument(input),
		seed,
		options.kindOrder ?? seededKindOrder(seed, input.id),
		options.maxKinds ?? DEFAULT_MAX_KINDS_PER_DOCUMENT,
	);
	return {
		documentId: input.id,
		...(batch !== undefined && { batch }),
		attempts,
	};
}

// ── The corpus and its census ────────────────────────────────────────

/**
 * The documents a corpus edits, in two parts that are assigned differently
 * so that the fuzz sample's size never changes a fixed document's batch.
 */
export interface EditCorpus {
	/**
	 * The fixed documents (the producers', workforce and expander documents;
	 * a targeted document carries no drawn edit, only the one it writes,
	 * `writtenEditBatch`). Their kinds are balanced across
	 * this list alone, so every kind the list can take lands on one of them,
	 * and a batch depends on this list and the seed, never on the sample.
	 */
	readonly fixed: readonly EditCorpusDocument[];
	/**
	 * The fixed-seed sample of the fuzz generators, sized by the lane's
	 * budget. Each document's batch is `editBatchFor(document, seed)` (with
	 * the corpus's `maxKindsPerDocument`): a function of the document and the
	 * seed alone.
	 */
	readonly sampled: readonly EditCorpusDocument[];
}

export interface KindCensus {
	/** Fixed documents on which this kind proposes a batch. */
	readonly fixedTargets: number;
	/**
	 * Documents on which this kind was tried: judged, or found to propose
	 * nothing while a document looked for a kind to keep.
	 */
	readonly tried: number;
	/** Batches proposed for it (including planner refusals). */
	readonly candidates: number;
	/** Tries where it proposed nothing: no target, and no birth supplies one. */
	readonly inapplicable: number;
	/** Refusals by code (`KindAttempt.refusals`). */
	readonly refused: Readonly<Record<string, number>>;
	/** Kept batches drawn for this kind. */
	readonly admitted: number;
	/** Mutations of this kind across every kept batch. */
	readonly admittedMutations: number;
	/** `admittedMutations` over all kept mutations. */
	readonly share: number;
}

export interface EditCensus {
	readonly seed: number;
	readonly documents: number;
	readonly batches: number;
	readonly mutations: number;
	/** Kept batches where the reference index names a reader of a touched entity. */
	readonly batchesWithReaders: number;
	readonly kinds: Readonly<Record<MutationKind, KindCensus>>;
	/** Kept mutations by `<kind>:<arm>`, for kinds with several arms. */
	readonly arms: Readonly<Record<string, number>>;
	/** Errors Nova raised instead of planning or judging, where they arose. */
	readonly errors: readonly {
		readonly documentId: string;
		readonly kind: MutationKind;
		readonly message: string;
	}[];
}

/** The arm of a kind whose one payload covers very different edits. */
export function mutationArm(mutation: Mutation): string | undefined {
	switch (mutation.kind) {
		case "updateField":
			return mutation.targetKind;
		case "convertField":
			return mutation.toKind;
		case "updateModule":
			if (mutation.caseSearchConfigPatch !== undefined) {
				return "caseSearchConfigPatch";
			}
			if (mutation.caseSearchConfigOperation !== undefined) {
				return `caseSearchConfigOperation:${mutation.caseSearchConfigOperation}`;
			}
			return mutation.ensureCaseListConfig === true
				? "ensureCaseListConfig"
				: "patch";
		case "updateForm":
			if (mutation.caseOperationChange !== undefined) {
				return `caseOperationChange:${mutation.caseOperationChange.operation}`;
			}
			if (mutation.caseOperationPatch !== undefined) {
				return `caseOperationPatch:${mutation.caseOperationPatch.operation}`;
			}
			return "patch";
		case "updateColumn":
			if (mutation.column !== undefined) return "column";
			if (mutation.sortPatch !== undefined) return "sortPatch";
			if (mutation.tilePatch !== undefined) return "tilePatch";
			return "visibilityPatch";
		case "updateAutomation":
			return mutation.targetKind;
		case "editAutomationItem":
			return `${mutation.targetKind}:${mutation.edit.collection}:${mutation.edit.operation}`;
		case "moveModule":
			if (mutation.parentModuleUuid === undefined) return "same-group";
			return mutation.parentModuleUuid === null ? "to-root" : "reparent";
		case "setCaseListMeta":
			return Object.keys(mutation.patch).sort().join("+");
		default:
			return undefined;
	}
}

interface MutableKindCensus {
	tried: number;
	candidates: number;
	inapplicable: number;
	refused: Record<string, number>;
	admitted: number;
	admittedMutations: number;
}

interface MutableOutcome {
	readonly documentId: string;
	batch?: KeptEditBatch;
	readonly attempts: KindAttempt[];
}

function byStableId(seed: number) {
	return (a: EditCorpusDocument, b: EditCorpusDocument): number =>
		stableHash(`${seed}\u0000${a.id}`) - stableHash(`${seed}\u0000${b.id}`) ||
		(a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The fixed documents' batches, kinds balanced across them.
 *
 * Every kind is proposed on every fixed document once, so each kind's
 * scarcity is known: how many fixed documents give it anything to target.
 * Then, scarcest kind first, each kind is judged on the fixed documents that
 * still have no batch (in an order fixed by the seed and their ids) until one
 * admits it; so a kind only a few documents can take is not crowded out by
 * one every document can. Each document left over tries the kinds kept least
 * often so far (then the ones refused least often, then a seeded order).
 */
function fixedOutcomes(
	documents: readonly EditCorpusDocument[],
	seed: number,
	maxKinds: number,
): {
	readonly outcomes: Map<string, MutableOutcome>;
	/** Per kind, the fixed documents on which it proposes a batch. */
	readonly scarcity: ReadonlyMap<MutationKind, number>;
} {
	const kept = new Map<MutationKind, number>(EDIT_KINDS.map((k) => [k, 0]));
	const refused = new Map<MutationKind, number>(EDIT_KINDS.map((k) => [k, 0]));
	const count = (map: Map<MutationKind, number>, kind: MutationKind) =>
		map.get(kind) ?? 0;
	const ordered = [...documents]
		.sort(byStableId(seed))
		.map((input) => prepareDocument(input));
	const proposals = new Map(
		ordered.map((document) => [
			document.input.id,
			new Map(
				EDIT_KINDS.map((kind) => [kind, proposeKind(document, seed, kind)]),
			),
		]),
	);
	const proposalOf = (document: PreparedDocument, kind: MutationKind) => {
		const proposal = proposals.get(document.input.id)?.get(kind);
		if (proposal === undefined) {
			throw new Error(
				`No proposal was drawn for ${kind} on ${document.input.id}; every kind is proposed on every fixed document before any is judged.`,
			);
		}
		return proposal;
	};
	const outcomes = new Map<string, MutableOutcome>(
		ordered.map((document) => [
			document.input.id,
			{ documentId: document.input.id, attempts: [] },
		]),
	);
	const record = (
		outcome: MutableOutcome,
		attempt: KindAttempt,
		batch: KeptEditBatch | undefined,
	) => {
		outcome.attempts.push(attempt);
		if (!attempt.admitted && attempt.candidates > 0) {
			refused.set(attempt.kind, count(refused, attempt.kind) + 1);
		}
		if (batch === undefined) return;
		outcome.batch = batch;
		kept.set(batch.intendedKind, count(kept, batch.intendedKind) + 1);
	};

	const scarcity = new Map(
		EDIT_KINDS.map((kind) => [
			kind,
			ordered.filter((document) => proposes(proposalOf(document, kind))).length,
		]),
	);
	const kindHash = (kind: MutationKind) => stableHash(`${seed}\u0000${kind}`);
	const coverage = EDIT_KINDS.filter((kind) => count(scarcity, kind) > 0).sort(
		(a, b) =>
			count(scarcity, a) - count(scarcity, b) || kindHash(a) - kindHash(b),
	);
	for (const kind of coverage) {
		for (const document of ordered) {
			const outcome = outcomes.get(document.input.id);
			const proposal = proposalOf(document, kind);
			if (outcome === undefined || outcome.batch !== undefined) continue;
			if (!proposes(proposal)) continue;
			const { attempt, batch } = judgeProposal(document, seed, proposal);
			record(outcome, attempt, batch);
			if (batch !== undefined) break;
		}
	}

	for (const document of ordered) {
		const outcome = outcomes.get(document.input.id);
		if (outcome === undefined || outcome.batch !== undefined) continue;
		const judged = new Set(outcome.attempts.map((a) => a.kind));
		const hashOrder = seededKindOrder(seed, document.input.id).filter(
			(kind) => !judged.has(kind),
		);
		const order = [...hashOrder].sort(
			(a, b) =>
				count(kept, a) - count(kept, b) ||
				count(refused, a) - count(refused, b) ||
				hashOrder.indexOf(a) - hashOrder.indexOf(b),
		);
		const { batch, attempts } = tryKinds(
			document,
			seed,
			order,
			maxKinds,
			(kind) => proposalOf(document, kind),
		);
		for (const [index, attempt] of attempts.entries()) {
			record(
				outcome,
				attempt,
				index === attempts.length - 1 ? batch : undefined,
			);
		}
	}
	return { outcomes, scarcity };
}

/**
 * One edit batch per corpus document, and the census over all of them.
 *
 * The fixed documents' kinds are balanced across the fixed list; each
 * sampled document's batch is its own `editBatchFor`. So the same corpus and
 * seed always give the same batches, whatever order the documents arrive in,
 * and changing the sample changes no fixed document's batch.
 */
export function editBatchCorpus(
	corpus: EditCorpus,
	seed: number,
	options: { readonly maxKindsPerDocument?: number } = {},
): {
	readonly outcomes: readonly EditBatchOutcome[];
	readonly census: EditCensus;
} {
	const maxKinds =
		options.maxKindsPerDocument ?? DEFAULT_MAX_KINDS_PER_DOCUMENT;
	const documents = [...corpus.fixed, ...corpus.sampled];
	const ids = new Set<string>();
	for (const document of documents) {
		if (ids.has(document.id)) {
			throw new Error(
				`Two corpus documents share the id ${document.id}. Each document's batch is keyed by its id, so give each one its own.`,
			);
		}
		ids.add(document.id);
	}

	const fixed = fixedOutcomes(corpus.fixed, seed, maxKinds);
	const outcomes: EditBatchOutcome[] = documents.map(
		(input) =>
			fixed.outcomes.get(input.id) ?? editBatchFor(input, seed, { maxKinds }),
	);

	const kinds = Object.fromEntries(
		EDIT_KINDS.map((kind) => [
			kind,
			{
				tried: 0,
				candidates: 0,
				inapplicable: 0,
				refused: {},
				admitted: 0,
				admittedMutations: 0,
			} satisfies MutableKindCensus,
		]),
	) as Record<MutationKind, MutableKindCensus>;
	const arms: Record<string, number> = {};
	const errors: { documentId: string; kind: MutationKind; message: string }[] =
		[];
	let batchesWithReaders = 0;
	let mutations = 0;
	let batches = 0;
	for (const outcome of outcomes) {
		for (const attempt of outcome.attempts) {
			const entry = kinds[attempt.kind];
			entry.tried += 1;
			entry.candidates += attempt.candidates;
			if (attempt.candidates === 0 && attempt.errors.length === 0) {
				entry.inapplicable += 1;
			}
			for (const code of attempt.refusals) {
				entry.refused[code] = (entry.refused[code] ?? 0) + 1;
			}
			for (const message of attempt.errors) {
				errors.push({
					documentId: outcome.documentId,
					kind: attempt.kind,
					message,
				});
			}
		}
		const kept = outcome.batch;
		if (kept === undefined) continue;
		batches += 1;
		kinds[kept.intendedKind].admitted += 1;
		if (kept.hasReaders) batchesWithReaders += 1;
		for (const mutation of kept.mutations) {
			mutations += 1;
			kinds[mutation.kind].admittedMutations += 1;
			const arm = mutationArm(mutation);
			if (arm !== undefined) {
				const key = `${mutation.kind}:${arm}`;
				arms[key] = (arms[key] ?? 0) + 1;
			}
		}
	}

	const census: EditCensus = {
		seed,
		documents: documents.length,
		batches,
		mutations,
		batchesWithReaders,
		kinds: Object.fromEntries(
			EDIT_KINDS.map((kind) => [
				kind,
				{
					fixedTargets: fixed.scarcity.get(kind) ?? 0,
					...kinds[kind],
					share:
						mutations === 0 ? 0 : kinds[kind].admittedMutations / mutations,
				},
			]),
		) as Record<MutationKind, KindCensus>,
		arms,
		errors,
	};
	return { outcomes, census };
}

/**
 * Per kind, the documents whose batch was drawn for it, in the order the
 * batches are given; a kind no batch was drawn for has an empty list.
 */
export function documentsByKind(
	batches: readonly Pick<KeptEditBatch, "documentId" | "intendedKind">[],
): Record<MutationKind, string[]> {
	const byKind = Object.fromEntries(
		EDIT_KINDS.map((kind) => [kind, [] as string[]]),
	) as Record<MutationKind, string[]>;
	for (const batch of batches) {
		byKind[batch.intendedKind].push(batch.documentId);
	}
	return byKind;
}

/**
 * Every kind no kept batch was drawn for, with the refusals it met. An empty
 * list is the floor: the corpus draws every kind the reducer defines.
 */
export function censusFloorFailures(census: EditCensus): {
	readonly kind: MutationKind;
	readonly fixedTargets: number;
	readonly tried: number;
	readonly refused: Readonly<Record<string, number>>;
}[] {
	return EDIT_KINDS.filter((kind) => census.kinds[kind].admitted === 0).map(
		(kind) => ({
			kind,
			fixedTargets: census.kinds[kind].fixedTargets,
			tried: census.kinds[kind].tried,
			refused: census.kinds[kind].refused,
		}),
	);
}

/** The census as a table for a log. */
export function formatCensus(census: EditCensus): string {
	const lines = [
		`Edit batches: ${census.batches} of ${census.documents} documents, ${census.mutations} mutations, ${census.batchesWithReaders} batches with readers (seed ${census.seed})`,
		"kind | fixed targets | tried | candidates | inapplicable | admitted | mutations | share | refused",
	];
	for (const kind of EDIT_KINDS) {
		const k = census.kinds[kind];
		const refused = Object.entries(k.refused)
			.sort((a, b) => b[1] - a[1])
			.map(([code, n]) => `${code}×${n}`)
			.join(" ");
		lines.push(
			`${kind} | ${k.fixedTargets} | ${k.tried} | ${k.candidates} | ${k.inapplicable} | ${k.admitted} | ${k.admittedMutations} | ${(k.share * 100).toFixed(1)}% | ${refused}`,
		);
	}
	for (const error of census.errors) {
		lines.push(
			`Nova raised an error on ${error.documentId} (${error.kind}): ${error.message}`,
		);
	}
	lines.push(
		"arms:",
		...Object.entries(census.arms)
			.sort((a, b) => (a[0] < b[0] ? -1 : 1))
			.map(([arm, n]) => `  ${arm} ${n}`),
	);
	return lines.join("\n");
}
