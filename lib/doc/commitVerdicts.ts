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
 * Accepting callers commit the candidate itself (the builder's
 * `commitDoc`, the MCP transactional write), so the doc the gate
 * validated IS the doc that lands — one reducer run, no
 * candidate-vs-committed divergence even for the one nondeterministic
 * reducer (`duplicateField`'s minted clone uuid).
 */

import { produce } from "immer";
import {
	type CsqlRepresentabilityIssue,
	checkCsqlRepresentability,
} from "@/lib/commcare/predicate";
import type { ValidationError } from "@/lib/commcare/validator/errors";
import {
	evaluateBoundary,
	evaluateCommit,
} from "@/lib/commcare/validator/gate";
import { MODULE_RULES } from "@/lib/commcare/validator/rules/module";
import type { ValidationScope } from "@/lib/commcare/validator";
import { scopeOfMutations } from "@/lib/commcare/validator/scopeOfMutations";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation, MutationResult } from "@/lib/doc/types";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";

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
	Map<Uuid, CaseWorkspaceBoundaryVerdicts>
>();

/** Run the same module-rule inventory as the commit/export boundary and retain
 * only findings owned by a case-workspace AST slot.
 *
 * Memoized per (doc reference, module uuid) — the `validationContextFor`
 * discipline. The inventory includes expensive rules (CSQL
 * representability) and the workspace hook re-runs its selector on every
 * doc-store notification; every committed batch produces a fresh doc
 * reference, so reference keying is sound. */
export function caseWorkspaceBoundaryVerdicts(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): CaseWorkspaceBoundaryVerdicts {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined) return CLEAN_CASE_WORKSPACE_BOUNDARY;

	const cachedPerModule = CASE_WORKSPACE_VERDICT_CACHE.get(doc);
	const cached = cachedPerModule?.get(moduleUuid);
	if (cached !== undefined) return cached;

	let filterBroken = false;
	let searchInputsBroken = false;
	let searchButtonConditionBroken = false;
	let excludedOwnerIdsBroken = false;
	const brokenColumnUuids = new Set<Uuid>();

	for (const rule of MODULE_RULES) {
		for (const finding of rule(mod, moduleUuid, doc)) {
			const slot =
				typeof finding.details?.slot === "string"
					? finding.details.slot
					: undefined;
			if (slot === "caseListConfig.filter") {
				filterBroken = true;
				continue;
			}
			if (slot?.startsWith("caseListConfig.searchInputs[") === true) {
				searchInputsBroken = true;
				continue;
			}
			if (slot === "caseSearchConfig.searchButtonDisplayCondition") {
				searchButtonConditionBroken = true;
				continue;
			}
			if (slot === "caseSearchConfig.excludedOwnerIds") {
				excludedOwnerIdsBroken = true;
				continue;
			}
			if (slot?.startsWith("caseListConfig.columns[") !== true) continue;
			const columnUuid = finding.details?.columnUuid;
			if (typeof columnUuid === "string") {
				brokenColumnUuids.add(columnUuid as Uuid);
			}
		}
	}

	const verdicts: CaseWorkspaceBoundaryVerdicts = {
		filterBroken,
		searchInputsBroken,
		searchButtonConditionBroken,
		excludedOwnerIdsBroken,
		brokenColumnUuids: [...brokenColumnUuids],
	};
	const perModule =
		cachedPerModule ?? new Map<Uuid, CaseWorkspaceBoundaryVerdicts>();
	if (cachedPerModule === undefined) {
		CASE_WORKSPACE_VERDICT_CACHE.set(doc, perModule);
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
	| { ok: true; nextDoc: BlueprintDoc; results: MutationResult[] }
	| { ok: false; nextDoc: BlueprintDoc; introduced: ValidationError[] };

/**
 * Candidate prepared exactly once for one commit attempt. Evaluation consumes
 * the candidate doc, reducer results, and precomputed validation scope; it has
 * no mutation batch to re-apply and therefore cannot invoke the reducer.
 */
export interface PreparedMutationCandidate {
	readonly nextDoc: BlueprintDoc;
	readonly results: MutationResult[];
	readonly scope: ValidationScope | "full";
	readonly mutationCount: number;
}

/**
 * Apply one mutation batch once and retain every value the later verdict and
 * accepting writer need. An authoritative retry prepares again only after it
 * opens a new transaction attempt and reloads that attempt's fresh base doc.
 */
export function prepareMutationCandidate(
	prevDoc: BlueprintDoc,
	mutations: readonly Mutation[],
): PreparedMutationCandidate {
	if (mutations.length === 0) {
		return {
			nextDoc: prevDoc,
			results: [],
			scope: scopeOfMutations(prevDoc, mutations),
			mutationCount: 0,
		};
	}

	let results: MutationResult[] = [];
	const nextDoc = produce(prevDoc, (draft) => {
		results = applyMutations(draft, mutations);
	});
	return {
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
	mutations: readonly Mutation[],
	lookupContext: LookupValidationContext,
): MutationCommitVerdict {
	return evaluatePreparedMutationCandidate(
		prevDoc,
		prepareMutationCandidate(prevDoc, mutations),
		lookupContext,
	);
}

/** A persisted mutation must carry every identity its reducer will install. */
export type PersistenceSafeMutation = Exclude<
	Mutation,
	{ readonly kind: "duplicateField" }
>;

/**
 * Reject reducer-minted identity mutations at persistence boundaries.
 *
 * `duplicateField` is intentionally a UI-only convenience event. The builder
 * applies it locally, then its doc diff persists explicit `addField` mutations
 * carrying the minted clone/subtree UUIDs. Replaying a raw `duplicateField`
 * in an authoritative transaction would mint a different candidate on every
 * retry and can never be an accepted-mutation wire contract. Any future
 * reducer convenience that mints identity must join this guard; persisted
 * mutations instead carry those identities in their payloads.
 */
export function assertPersistenceSafeMutationIdentities(
	mutations: readonly Mutation[],
): asserts mutations is readonly PersistenceSafeMutation[] {
	const reducerMinted = mutations.find(
		(mutation) => mutation.kind === "duplicateField",
	);
	if (reducerMinted !== undefined) {
		throw new Error(
			"duplicateField is UI-only and cannot be persisted; persist explicit addField mutations carrying every minted UUID.",
		);
	}
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
 * Project's asset manifest through `lib/media/boundaryValidation.ts`.
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
