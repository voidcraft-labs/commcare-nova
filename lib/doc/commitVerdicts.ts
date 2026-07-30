/**
 * Mutation-commit verdicts — the shared "may this batch commit?"
 * decision every write surface consults BEFORE persisting or
 * dispatching a mutation batch.
 *
 * The generalization of the `identifierVerdicts.ts` pattern from one
 * rule family (field ids) to the whole validator: apply the batch to a
 * candidate doc, run the introduced-error gate
 * (`lib/commcare/validator/gate.ts::evaluateCommit`) under the scope the
 * batch can affect (`scopeOfMutations`), and return a typed verdict.
 * One verdict, every caller — the SA/MCP tool layer
 * (`lib/agent/tools/common.ts::guardedMutate`) and the builder's
 * dispatch hook (`useBlueprintMutations`) consume the same function, so
 * "rejected here, accepted there" can't drift between surfaces.
 *
 * Semantics live entirely in `evaluateCommit` — introduced-error
 * diffing and the gating-class filter are never re-derived here.
 * Reducers stay total and never call this: a degenerate historical
 * event must still replay.
 *
 * Bypasses: undo/redo, hydration, the agent stream, and replay write
 * through the store directly — they replay already-committed states.
 *
 * Pure — the candidate `nextDoc` is computed via Immer `produce` over
 * the same `applyMutations` reducer every committed batch runs through.
 * Accepting callers commit the candidate itself (the builder's `commitDoc`,
 * the MCP transactional write), so the doc the gate validated IS the doc that
 * lands, at one reducer run per dispatch. Every reducer is deterministic —
 * mutations carry the identities they install rather than minting them on the
 * way past — so re-running would reach the same document; committing the
 * candidate is about doing the work once, not about avoiding a divergence.
 */

import { produce } from "immer";
import {
	type CsqlRepresentabilityIssue,
	checkCsqlRepresentability,
} from "@/lib/commcare/predicate";
import { matchModeRunsOnDevice } from "@/lib/commcare/predicate/matchModes";
import type { ValidationScope } from "@/lib/commcare/validator";
import {
	type ValidationError,
	validationError,
} from "@/lib/commcare/validator/errors";
import {
	evaluateBoundary,
	evaluateCommit,
} from "@/lib/commcare/validator/gate";
import { validateLookupReferences } from "@/lib/commcare/validator/lookupReferences";
import { lookupTypeIndex } from "@/lib/commcare/validator/lookupTypeContext";
import { MODULE_RULES } from "@/lib/commcare/validator/rules/module";
import { scopeOfMutations } from "@/lib/commcare/validator/scopeOfMutations";
import {
	type LookupValidationContext,
	PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
} from "@/lib/doc/lookupReferences";
import {
	type AdmittedMutationBatch,
	admitMutationBatch,
	MutationWireCanonicalityError,
} from "@/lib/doc/mutationAdmission";
import {
	type MutationIdentityAdmissionIssue,
	mutationIdentityAdmissionIssue,
} from "@/lib/doc/mutationIdentityAdmission";
import {
	type MutationSequenceAdmissionIssue,
	mutationSequenceAdmissionIssue,
} from "@/lib/doc/mutationSequenceAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import type { MutationResult } from "@/lib/doc/types";
import { type BlueprintDoc, type Uuid, uuidSchema } from "@/lib/domain";
import type { MatchMode, Predicate } from "@/lib/domain/predicate";

export type PredicateEditVerdict =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

function representabilityIssueKey(issue: CsqlRepresentabilityIssue): string {
	return `${issue.reason}\0${issue.path.map(String).join("\0")}`;
}

function predicateEditIssueReason(issue: CsqlRepresentabilityIssue): string {
	if (issue.reason === "case-property-on-value-side") {
		return "This condition already uses case information. Choose a value, search answer, app information, user information, or a calculation instead.";
	}
	if (issue.reason === "comparison-needs-case-property") {
		return "Choose case information for one side of this condition.";
	}
	return issue.message;
}

/**
 * Decide whether one in-place edit may be offered inside a case-search rule.
 *
 * The builder deliberately asks this domain-facing question instead of
 * importing or re-implementing CommCare's CSQL grammar. Comparing the current
 * and candidate trees is load-bearing for recovery: an imported rule may
 * already contain a finding, and changing a different value must remain
 * possible as long as that edit introduces nothing new. This mirrors the
 * commit gate's delta semantics while giving a picker a concise reason before
 * the author chooses an unsupported value source.
 */
export function caseSearchPredicateEditVerdict(
	current: Predicate,
	candidate: Predicate,
): PredicateEditVerdict {
	const existing = new Set(
		checkCsqlRepresentability(current).map(representabilityIssueKey),
	);
	const introduced = checkCsqlRepresentability(candidate).find(
		(issue) => !existing.has(representabilityIssueKey(issue)),
	);
	return introduced === undefined
		? { ok: true }
		: { ok: false, reason: predicateEditIssueReason(introduced) };
}

/**
 * Whether CommCare's own evaluator implements `mode`, for a slot that runs
 * on the device rather than as a remote case-search query.
 *
 * The builder asks the same question the on-device emitter and the two
 * portability rules ask, through this boundary rather than by restating a
 * CommCare fact in React code — the mode table lives once, at
 * `lib/commcare/predicate/matchModes.ts`. A picker needs it because the
 * refusal is otherwise invisible until commit: the three case-search modes
 * type-check perfectly, so nothing short of the wire dialect knows they
 * cannot run.
 */
export function matchModeAvailableOnDevice(mode: MatchMode): boolean {
	return matchModeRunsOnDevice(mode);
}

/** Absolute readiness verdict for a predicate that will execute as a remote
 * case-search query. Whole-config status surfaces use this to mark an imported
 * unsupported rule before the author touches it; edit menus use the delta
 * verdict above so that same rule remains repairable. */
export function caseSearchPredicateVerdict(
	predicate: Predicate,
): PredicateEditVerdict {
	const issue = checkCsqlRepresentability(predicate)[0];
	return issue === undefined
		? { ok: true }
		: { ok: false, reason: predicateEditIssueReason(issue) };
}

/** Absolute validator projection for the case-list workspace. The commit gate
 * is deliberately delta-based, while workspace status must expose existing
 * imported findings. Running the actual module rules keeps that status aligned
 * with every type, wire, and on-device constraint without recreating their
 * private walkers in React code. */
export interface CaseWorkspaceBoundaryVerdicts {
	readonly filterBroken: boolean;
	readonly searchInputsBroken: boolean;
	readonly searchButtonConditionBroken: boolean;
	readonly excludedOwnerIdsBroken: boolean;
	readonly brokenColumnUuids: readonly Uuid[];
}

const CLEAN_CASE_WORKSPACE_BOUNDARY: CaseWorkspaceBoundaryVerdicts = {
	filterBroken: false,
	searchInputsBroken: false,
	searchButtonConditionBroken: false,
	excludedOwnerIdsBroken: false,
	brokenColumnUuids: [],
};

const CASE_WORKSPACE_VERDICT_CACHE = new WeakMap<
	BlueprintDoc,
	Map<LookupValidationContext, Map<Uuid, CaseWorkspaceBoundaryVerdicts>>
>();

/** Run the same module-rule inventory as the commit/export boundary and retain
 * only findings owned by a case-workspace AST slot.
 *
 * The client workspace deliberately supplies `LOOKUP_CONTEXT_UNAVAILABLE`: it
 * has no rows-free Project definition snapshot, and pretending an empty
 * registry were authoritative would hide historical carriers. Structural
 * lookup findings still mark their owning workspace surface broken; fetching
 * definitions belongs to a future context-owning boundary, not this selector.
 *
 * Memoized per (doc reference, lookup-context identity, module uuid) — the
 * `validationContextFor` discipline. The inventory includes expensive rules
 * (CSQL representability) and the workspace hook re-runs its selector on every
 * doc-store notification; every committed batch produces a fresh doc
 * reference, while a changed lookup snapshot has a fresh context identity. */
export function caseWorkspaceBoundaryVerdicts(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	lookupContext: LookupValidationContext,
): CaseWorkspaceBoundaryVerdicts {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined) return CLEAN_CASE_WORKSPACE_BOUNDARY;

	const cachedPerContext = CASE_WORKSPACE_VERDICT_CACHE.get(doc);
	const cachedPerModule = cachedPerContext?.get(lookupContext);
	const cached = cachedPerModule?.get(moduleUuid);
	if (cached !== undefined) return cached;

	let filterBroken = false;
	let searchInputsBroken = false;
	let searchButtonConditionBroken = false;
	let excludedOwnerIdsBroken = false;
	const brokenColumnUuids = new Set<Uuid>();

	const lookupTables = lookupTypeIndex(lookupContext);
	const findings = MODULE_RULES.flatMap((rule) =>
		rule(mod, moduleUuid, doc, lookupTables),
	);
	findings.push(
		...validateLookupReferences(
			doc,
			lookupContext,
			PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
		).filter((finding) => finding.location.moduleUuid === moduleUuid),
	);

	for (const finding of findings) {
		const slot =
			typeof finding.details?.slot === "string"
				? finding.details.slot
				: undefined;
		const registrySlot = finding.details?.registrySlot;
		if (
			slot === "caseListConfig.filter" ||
			registrySlot === "case_list_filter"
		) {
			filterBroken = true;
			continue;
		}
		if (
			slot?.startsWith("caseListConfig.searchInputs[") === true ||
			registrySlot === "search_input_default" ||
			registrySlot === "search_input_predicate"
		) {
			searchInputsBroken = true;
			continue;
		}
		if (
			slot === "caseSearchConfig.searchButtonDisplayCondition" ||
			registrySlot === "search_button_display_condition"
		) {
			searchButtonConditionBroken = true;
			continue;
		}
		if (
			slot === "caseSearchConfig.excludedOwnerIds" ||
			registrySlot === "excluded_owner_ids"
		) {
			excludedOwnerIdsBroken = true;
			continue;
		}
		if (
			slot?.startsWith("caseListConfig.columns[") !== true &&
			registrySlot !== "case_list_column_expression"
		) {
			continue;
		}
		const columnUuid =
			finding.details?.columnUuid ?? finding.details?.carrierUuid;
		const parsedColumnUuid = uuidSchema.safeParse(columnUuid);
		if (parsedColumnUuid.success) brokenColumnUuids.add(parsedColumnUuid.data);
	}

	const verdicts: CaseWorkspaceBoundaryVerdicts = {
		filterBroken,
		searchInputsBroken,
		searchButtonConditionBroken,
		excludedOwnerIdsBroken,
		brokenColumnUuids: [...brokenColumnUuids],
	};
	const perContext =
		cachedPerContext ??
		new Map<
			LookupValidationContext,
			Map<Uuid, CaseWorkspaceBoundaryVerdicts>
		>();
	if (cachedPerContext === undefined) {
		CASE_WORKSPACE_VERDICT_CACHE.set(doc, perContext);
	}
	const perModule =
		cachedPerModule ?? new Map<Uuid, CaseWorkspaceBoundaryVerdicts>();
	if (cachedPerModule === undefined) {
		perContext.set(lookupContext, perModule);
	}
	perModule.set(moduleUuid, verdicts);
	return verdicts;
}

/**
 * The verdict shape every commit surface consumes. `nextDoc` is always
 * present: an accepting caller commits/persists it; a rejecting caller
 * discards it and renders the `introduced` findings (each carries the
 * validator's person-to-person `message`). The accepting arm also
 * carries the reducers' per-mutation `results` (rename/move metadata)
 * from the candidate run, so a caller that commits `nextDoc` directly
 * never needs a second reducer pass to recover them.
 */
export type MutationCommitVerdict =
	| {
			ok: true;
			nextDoc: BlueprintDoc;
			results: MutationResult[];
			mutations: AdmittedMutationBatch;
			prepared: PreparedMutationCandidate;
	  }
	| { ok: false; nextDoc: BlueprintDoc; introduced: ValidationError[] };

/**
 * Candidate prepared exactly once for one commit attempt. Evaluation consumes
 * the candidate doc, reducer results, and precomputed validation scope; it has
 * no mutation batch to re-apply and therefore cannot invoke the reducer.
 */
export interface PreparedMutationCandidate {
	readonly mutations: AdmittedMutationBatch;
	readonly nextDoc: BlueprintDoc;
	readonly results: MutationResult[];
	readonly scope: ValidationScope | "full";
	readonly mutationCount: number;
	readonly identityAdmissionIssue?: MutationIdentityAdmissionIssue;
	readonly sequenceAdmissionIssue?: MutationSequenceAdmissionIssue;
}

/**
 * Apply one mutation batch once and retain every value the later verdict and
 * accepting writer need. An authoritative retry prepares again only after it
 * opens a new transaction attempt and reloads that attempt's fresh base doc.
 */
export function prepareMutationCandidate(
	prevDoc: BlueprintDoc,
	mutations: AdmittedMutationBatch,
): PreparedMutationCandidate {
	if (mutations.length === 0) {
		return {
			mutations,
			nextDoc: prevDoc,
			results: [],
			scope: scopeOfMutations(prevDoc, mutations),
			mutationCount: 0,
		};
	}

	const identityIssue = mutationIdentityAdmissionIssue(prevDoc, mutations);
	if (identityIssue !== undefined) {
		return {
			mutations,
			nextDoc: prevDoc,
			results: [],
			scope: "full",
			mutationCount: mutations.length,
			identityAdmissionIssue: identityIssue,
		};
	}
	const sequenceIssue = mutationSequenceAdmissionIssue(prevDoc, mutations);
	if (sequenceIssue !== undefined) {
		return {
			mutations,
			nextDoc: prevDoc,
			results: [],
			scope: "full",
			mutationCount: mutations.length,
			sequenceAdmissionIssue: sequenceIssue,
		};
	}

	let results: MutationResult[] = [];
	const nextDoc = produce(prevDoc, (draft) => {
		results = applyMutations(draft, mutations);
	});
	return {
		mutations,
		nextDoc,
		results,
		scope: scopeOfMutations(prevDoc, mutations),
		mutationCount: mutations.length,
	};
}

/**
 * Evaluate a prepared candidate without applying its mutations again. Previous
 * and candidate validation receive the exact same context object.
 */
export function evaluatePreparedMutationCandidate(
	prevDoc: BlueprintDoc,
	prepared: PreparedMutationCandidate,
	lookupContext: LookupValidationContext,
): MutationCommitVerdict {
	if (prepared.mutationCount === 0) {
		return {
			ok: true,
			nextDoc: prepared.nextDoc,
			results: prepared.results,
			mutations: prepared.mutations,
			prepared,
		};
	}
	if (prepared.identityAdmissionIssue !== undefined) {
		const issue = prepared.identityAdmissionIssue;
		return {
			ok: false,
			nextDoc: prepared.nextDoc,
			introduced: [
				validationError(
					"MUTATION_IDENTITY_COLLISION",
					"app",
					`This change tried to create a ${issue.incomingKind} with identity "${issue.uuid}", but that identity already belongs to a ${issue.existingKind}. Every authored app object must have its own stable identity.`,
					{},
					{
						mutationIndex: String(issue.mutationIndex),
						mutationKind: issue.mutationKind,
						entityUuid: issue.uuid,
						existingKind: issue.existingKind,
						incomingKind: issue.incomingKind,
					},
				),
			],
		};
	}
	if (prepared.sequenceAdmissionIssue !== undefined) {
		const issue = prepared.sequenceAdmissionIssue;
		return {
			ok: false,
			nextDoc: prepared.nextDoc,
			introduced: [
				validationError(
					"MUTATION_SEQUENCE_ANCHOR_INVALID",
					"app",
					`This change tried to place an item after "${issue.anchor}", but that neighbor is not in ${issue.collection}. Reload the latest app and choose a current neighbor.`,
					{},
					{
						mutationIndex: String(issue.mutationIndex),
						mutationKind: issue.mutationKind,
						collection: issue.collection,
						anchor: issue.anchor,
					},
				),
			],
		};
	}

	const verdict = evaluateCommit({
		prevDoc,
		nextDoc: prepared.nextDoc,
		scope: prepared.scope,
		lookupContext,
	});
	return verdict.ok
		? {
				ok: true,
				nextDoc: prepared.nextDoc,
				results: prepared.results,
				mutations: prepared.mutations,
				prepared,
			}
		: {
				ok: false,
				nextDoc: prepared.nextDoc,
				introduced: verdict.introduced,
			};
}

/**
 * Gate one mutation batch against the doc it would apply to. An empty
 * batch passes without running validation — there is nothing to
 * introduce.
 */
export function mutationCommitVerdict(
	prevDoc: BlueprintDoc,
	mutations: unknown,
	lookupContext: LookupValidationContext,
): MutationCommitVerdict {
	let admitted: AdmittedMutationBatch;
	try {
		admitted = admitMutationBatch(mutations);
	} catch (error) {
		if (!(error instanceof MutationWireCanonicalityError)) throw error;
		return mutationWireCanonicalityRejection(prevDoc, error);
	}
	return evaluatePreparedMutationCandidate(
		prevDoc,
		prepareMutationCandidate(prevDoc, admitted),
		lookupContext,
	);
}

export function mutationWireCanonicalityRejection(
	prevDoc: BlueprintDoc,
	error: MutationWireCanonicalityError,
): MutationCommitVerdict {
	return {
		ok: false,
		nextDoc: prevDoc,
		introduced: [
			validationError(
				"MUTATION_WIRE_CANONICALITY_INVALID",
				"app",
				"This edit could not be saved because its mutation data was not canonical.",
				{},
				{
					mutationIndex:
						error.details.mutationIndex === null
							? "root"
							: String(error.details.mutationIndex),
					pointer: error.details.pointer,
					reason: error.details.reason,
				},
			),
		],
	};
}

/**
 * The EXPORT-readiness findings for a whole doc — the zero-tolerance bar the
 * compile / upload / export boundary applies.
 *
 * `mutationCommitVerdict` cannot answer this question. It is DELTA-based: a
 * pre-existing finding never blocks a commit, so an empty app's `NO_MODULES` /
 * `EMPTY_APP_NAME` survive every batch that doesn't introduce something new.
 * A caller that must establish "this doc is exportable" as a fact — rather
 * than "this batch made nothing worse" — asks here.
 *
 * The manifest is empty, so a doc carrying media references reports them
 * missing. Only callers whose docs hold no media may use this (today: the
 * creation templates in `scaffolds.ts`). The real export path threads the
 * Project's external-resource snapshots through `lib/export/boundaryValidation.ts`.
 */
export function exportReadinessFindings(
	doc: BlueprintDoc,
	lookupContext: LookupValidationContext,
): ValidationError[] {
	return evaluateBoundary(doc, new Map(), lookupContext);
}

/**
 * Compose a rejection's findings into one person-to-person message — the
 * `{ error }` envelope the SA/MCP tool layer returns, and the prose the
 * builder's rejection notice shows. Each finding's `message` is already
 * a self-contained sentence naming what's wrong and where it lives; this
 * adds only the frame: nothing was changed, fix the edit and retry.
 */
export function describeIntroducedErrors(
	introduced: readonly ValidationError[],
): string {
	const lines = introduced.map((err) => `- ${err.message}`).join("\n");
	const plural = introduced.length === 1 ? "a new problem" : "new problems";
	return `This change wasn't applied — it would introduce ${plural}:\n${lines}\nNothing was changed. Adjust the edit so it doesn't create ${
		introduced.length === 1 ? "this problem" : "these problems"
	}, then try again.`;
}
