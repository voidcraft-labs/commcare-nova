/**
 * Mutation-commit verdicts — the shared "may this batch commit?"
 * decision every write surface consults BEFORE persisting or
 * dispatching a mutation batch.
 *
 * The generalization of the `identifierVerdicts.ts` pattern from one
 * rule family (field ids) to the whole validator: apply the batch to a
 * candidate doc, run the absolute whole-candidate gate
 * (`lib/commcare/validator/gate.ts::evaluateCommit`), and return a typed verdict.
 * One verdict, every caller — the SA/MCP tool workspace
 * (`lib/agent/workspace/canonicalWorkspace.ts::gateAdmittedBatch`, behind
 * `lib/agent/tools/common.ts::guardedMutate`) and the builder's
 * dispatch hook (`useBlueprintMutations`) consume the same composition, so
 * "rejected here, accepted there" can't drift between surfaces.
 *
 * Semantics live in the validator gate — the gating-class filter is never
 * re-derived here. Absolute/server boundaries evaluate the whole document.
 * The Builder additionally preserves validity by induction for conservatively
 * classified mutation footprints: app-wide and lookup rules plus the complete
 * touched form/module run, while every unclassified edit falls back to the
 * absolute gate. Reducers do not validate; every lifecycle path must prepare
 * and evaluate before accepting a state.
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
	findOnDeviceDateAddIssue,
	findOnDeviceDateAddIssueInPredicate,
	type OnDeviceDateAddIssue,
} from "@/lib/commcare/expression/onDeviceCompatibility";
import {
	type CsqlRepresentabilityIssue,
	checkCsqlRepresentability,
} from "@/lib/commcare/predicate/csqlRepresentability";
import { walkCsqlOnDeviceNodes } from "@/lib/commcare/predicate/csqlRuntimeWalk";
import { matchModeRunsOnDevice } from "@/lib/commcare/predicate/matchModes";
import { classifyRelatedCaseSearchExpression } from "@/lib/commcare/suite/case-search/relatedCaseProjection";
import type { ValidationScope } from "@/lib/commcare/validator";
import {
	type ValidationError,
	validationError,
} from "@/lib/commcare/validator/errors";
import {
	evaluateBoundary,
	evaluateCommit,
	evaluateScopedCommit,
} from "@/lib/commcare/validator/gate";
import { validateLookupReferences } from "@/lib/commcare/validator/lookupReferences";
import { lookupTypeIndex } from "@/lib/commcare/validator/lookupTypeContext";
import { MODULE_RULES } from "@/lib/commcare/validator/rules/module";
import {
	type CasePropertyRenamePlan,
	type CasePropertyRenamePlanIssue,
	planCasePropertyRenames,
} from "@/lib/doc/casePropertyRenames";
import { incrementalValidationScope } from "@/lib/doc/incrementalValidationScope";
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
import { hasMutationPrevalidation } from "@/lib/doc/mutationPrevalidation";
import {
	type MutationSequenceAdmissionIssue,
	mutationSequenceAdmissionIssue,
} from "@/lib/doc/mutationSequenceAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import { mutationTargetsInvalid } from "@/lib/doc/mutationTargetAdmission";
import type { MutationResult } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	MODULE_REFERENCE_SLOTS,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import type {
	MatchMode,
	Predicate,
	RelationEvaluationScopeContext,
	TypeContext,
	ValueExpression,
} from "@/lib/domain/predicate";

export type PredicateEditVerdict =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

/** The runtime family that will evaluate one authored expression carrier. */
export type ExpressionEvaluationTarget =
	| "on-device"
	| "case-search"
	| "on-device-and-case-search";

function predicateEditIssueReason(issue: CsqlRepresentabilityIssue): string {
	if (issue.reason === "case-property-on-value-side") {
		return "This condition already uses case information. Choose a value, search answer, app information, user information, or a calculation instead.";
	}
	if (issue.reason === "comparison-needs-case-property") {
		return "Choose case information for one side of this condition.";
	}
	return issue.message;
}

function dateAddEditIssueReason(issue: OnDeviceDateAddIssue): string {
	return issue.reason === "datetime-base"
		? "Date and time calculations aren't available here because the time would be lost. Use a whole date or choose another calculation."
		: "Month and year calculations aren't available here. Use seconds, minutes, hours, days, or weeks.";
}

function caseSearchDateAddIssue(
	predicate: Predicate,
	context: TypeContext,
): OnDeviceDateAddIssue | undefined {
	let issue: OnDeviceDateAddIssue | undefined;
	walkCsqlOnDeviceNodes(predicate, {
		visitExpression(expression) {
			if (issue === undefined) {
				issue = findOnDeviceDateAddIssue(expression, context);
			}
		},
	});
	return issue;
}

/**
 * Whole-candidate authoring verdict for a predicate expression edit.
 *
 * A remote case-search rule is mixed-runtime: CSQL-native date functions stay
 * on the server, while a non-native expression subtree is interpolated as
 * JavaRosa XPath and must obey the on-device restriction. The shared dialect
 * walker keeps this projection aligned with the validator and emitter.
 */
export function predicateExpressionRuntimeEditVerdict(
	candidate: Predicate,
	target: ExpressionEvaluationTarget,
	context: TypeContext,
): PredicateEditVerdict {
	if (target !== "on-device") {
		const representabilityIssue = checkCsqlRepresentability(candidate)[0];
		if (representabilityIssue !== undefined) {
			return {
				ok: false,
				reason: predicateEditIssueReason(representabilityIssue),
			};
		}
	}

	const dateIssue =
		target === "case-search"
			? caseSearchDateAddIssue(candidate, context)
			: findOnDeviceDateAddIssueInPredicate(candidate, context);
	return dateIssue === undefined
		? { ok: true }
		: { ok: false, reason: dateAddEditIssueReason(dateIssue) };
}

/** Whole-candidate authoring verdict for a standalone value expression. */
export function valueExpressionRuntimeEditVerdict(
	candidate: ValueExpression,
	target: ExpressionEvaluationTarget,
	context: TypeContext,
): PredicateEditVerdict {
	if (target === "case-search") return { ok: true };
	const issue = findOnDeviceDateAddIssue(candidate, context);
	return issue === undefined
		? { ok: true }
		: { ok: false, reason: dateAddEditIssueReason(issue) };
}

const SEARCH_RELATED_CALCULATION_EDIT_REASON =
	"Search can show one parent property by itself, but it can't use other related-case information in this calculated item. Choose the parent property by itself, or build the calculation from this case.";

/**
 * Whole-candidate authoring verdict for a calculated Results/Details value in
 * an effective Search module.
 *
 * Builder authoring asks the compile boundary's classifier whether the whole
 * expression is current-case-only or one directly projected ancestor
 * property. Keeping the decision there also preserves its graph resolution
 * and reserved-path rules without restating them here.
 */
export function caseSearchCalculatedExpressionEditVerdict(
	candidate: ValueExpression,
	context: RelationEvaluationScopeContext,
): PredicateEditVerdict {
	return classifyRelatedCaseSearchExpression(candidate, context).kind !==
		"unsupported"
		? { ok: true }
		: { ok: false, reason: SEARCH_RELATED_CALCULATION_EDIT_REASON };
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
 * unsupported rule before the author touches it; edit menus use the same
 * absolute verdict so an invalid rule cannot be retained. */
export function caseSearchPredicateVerdict(
	predicate: Predicate,
): PredicateEditVerdict {
	const issue = checkCsqlRepresentability(predicate)[0];
	return issue === undefined
		? { ok: true }
		: { ok: false, reason: predicateEditIssueReason(issue) };
}

/** Absolute validator projection for the case-list workspace. Running the
 * actual module rules keeps that status aligned
 * with every type, wire, and on-device constraint without recreating their
 * private walkers in React code. */
/**
 * Every registry slot that lives on a search input, so a lookup or
 * expression finding on any of them marks Search broken. Read from the
 * registry rather than spelled by hand: the registry grows (options,
 * required conditions, validation rules, hidden values) and a hand-written
 * set silently misses the new ones, leaving the workspace clean while the
 * export boundary refuses.
 */
const SEARCH_INPUT_REGISTRY_SLOTS: ReadonlySet<string> = new Set(
	MODULE_REFERENCE_SLOTS.filter((entry) =>
		entry.path.startsWith("caseListConfig.searchInputs["),
	).map((entry) => entry.slot),
);

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
			(registrySlot !== undefined &&
				SEARCH_INPUT_REGISTRY_SLOTS.has(registrySlot))
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
 * discards it and renders the candidate's findings (each carries the
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
	| { ok: false; nextDoc: BlueprintDoc; findings: ValidationError[] };

/**
 * Candidate prepared exactly once for one commit attempt. Evaluation consumes
 * the candidate doc and reducer results; it has no mutation batch to re-apply
 * and therefore cannot invoke the reducer.
 */
export interface PreparedMutationCandidate {
	readonly mutations: AdmittedMutationBatch;
	readonly nextDoc: BlueprintDoc;
	readonly results: MutationResult[];
	readonly identityAdmissionIssue?: MutationIdentityAdmissionIssue;
	readonly sequenceAdmissionIssue?: MutationSequenceAdmissionIssue;
	readonly targetAdmissionIssue?: true;
	readonly renamePlanIssue?: CasePropertyRenamePlanIssue;
	readonly casePropertyRenamePlan?: CasePropertyRenamePlan;
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
	/* Scalar field patches neither claim identities nor alter sequence
	 * membership. Avoid materializing both whole-document admission indexes for
	 * the Builder's most frequent edit path. Inline option replacement remains
	 * structural because it replaces option identities. */
	const scalarFieldUpdate =
		mutations.length === 1 &&
		mutations[0]?.kind === "updateField" &&
		!("optionsSource" in mutations[0].patch);
	const identityIssue = scalarFieldUpdate
		? undefined
		: mutationIdentityAdmissionIssue(prevDoc, mutations);
	if (identityIssue !== undefined) {
		return {
			mutations,
			nextDoc: prevDoc,
			results: [],
			identityAdmissionIssue: identityIssue,
		};
	}
	const sequenceIssue = scalarFieldUpdate
		? undefined
		: mutationSequenceAdmissionIssue(prevDoc, mutations);
	if (sequenceIssue !== undefined) {
		return {
			mutations,
			nextDoc: prevDoc,
			results: [],
			sequenceAdmissionIssue: sequenceIssue,
		};
	}
	if (mutationTargetsInvalid(prevDoc, mutations)) {
		return {
			mutations,
			nextDoc: prevDoc,
			results: [],
			targetAdmissionIssue: true,
		};
	}
	const renameMutation =
		mutations.length === 1 && mutations[0]?.kind === "renameCaseProperties"
			? mutations[0]
			: undefined;
	const renamePlan =
		renameMutation === undefined
			? undefined
			: planCasePropertyRenames(prevDoc, renameMutation);
	if (renamePlan !== undefined && !renamePlan.ok)
		return {
			mutations,
			nextDoc: prevDoc,
			results: [],
			renamePlanIssue: renamePlan.issue,
		};
	if (mutations.length === 0) {
		return {
			mutations,
			nextDoc: prevDoc,
			results: [],
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
		...(renamePlan !== undefined && {
			casePropertyRenamePlan: renamePlan.plan,
		}),
	};
}

/**
 * Whether preparation stopped at an admission issue — an identity collision,
 * a stale sequence anchor, an invalid target, or an unplannable rename. Such a
 * candidate's verdict is that admission finding alone: the evaluator returns
 * it before consulting the validator or the lookup context, so a caller that
 * would otherwise pay for a Project definition read can skip it.
 */
export function preparedCandidateHasAdmissionIssue(
	prepared: PreparedMutationCandidate,
): boolean {
	return (
		prepared.identityAdmissionIssue !== undefined ||
		prepared.sequenceAdmissionIssue !== undefined ||
		prepared.targetAdmissionIssue === true ||
		prepared.renamePlanIssue !== undefined
	);
}

/**
 * Evaluate a prepared candidate without applying its mutations again. With no
 * explicit scope this is the absolute gate; a supplied scope is a dependency
 * footprint already proven by the Builder classifier.
 */
export function evaluatePreparedMutationCandidate(
	prepared: PreparedMutationCandidate,
	lookupContext: LookupValidationContext,
	options?: { readonly validationScope?: ValidationScope },
): MutationCommitVerdict {
	if (prepared.identityAdmissionIssue !== undefined) {
		const issue = prepared.identityAdmissionIssue;
		return {
			ok: false,
			nextDoc: prepared.nextDoc,
			findings: [
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
			findings: [
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
	if (prepared.targetAdmissionIssue === true) {
		return {
			ok: false,
			nextDoc: prepared.nextDoc,
			findings: [
				validationError(
					"MUTATION_TARGET_INVALID",
					"app",
					"This change refers to a target whose identity, kind, scope, action, or collection membership is not valid in the current app.",
					{},
				),
			],
		};
	}
	if (prepared.renamePlanIssue !== undefined) {
		const issue = prepared.renamePlanIssue;
		return {
			ok: false,
			nextDoc: prepared.nextDoc,
			findings: [
				validationError(
					"MUTATION_CASE_PROPERTY_RENAME_INVALID",
					"app",
					"This change does not define one lossless case-property rename for the batch.",
					{},
					{
						mutationIndex: String(issue.mutationIndex),
						renameIndex: String(issue.renameIndex),
						caseType: issue.caseType,
						from: issue.from,
						to: issue.to,
						reason: issue.reason,
					},
				),
			],
		};
	}

	const verdict =
		options?.validationScope === undefined
			? evaluateCommit({
					nextDoc: prepared.nextDoc,
					lookupContext,
				})
			: evaluateScopedCommit({
					nextDoc: prepared.nextDoc,
					lookupContext,
					scope: options.validationScope,
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
				findings: verdict.findings,
			};
}

/**
 * Gate one mutation batch against the doc it would apply to. Empty batches
 * still validate the unchanged candidate, so no lifecycle path can preserve
 * an invalid document by doing nothing.
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
		prepareMutationCandidate(prevDoc, admitted),
		lookupContext,
	);
}

/**
 * Builder gate with an exact off-thread proof fast path.
 *
 * A control may evaluate its exact full candidate before the author commits
 * it. Reuse that success only while the live document and lookup context are
 * the identical snapshots registered with the proof. Wire, identity,
 * sequence, target, and rename admission still run on the main thread; any
 * different batch, changed snapshot, or stale proof uses the ordinary
 * absolute gate.
 */
export function mutationCommitVerdictWithPrevalidation(
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
	const prepared = prepareMutationCandidate(prevDoc, admitted);
	const prevalidated = hasMutationPrevalidation(
		prevDoc,
		lookupContext,
		admitted,
	);
	if (preparedCandidateHasAdmissionIssue(prepared)) {
		// This returns the exact admission finding before reaching evaluateCommit.
		return evaluatePreparedMutationCandidate(prepared, lookupContext);
	}
	if (prevalidated) {
		return {
			ok: true,
			nextDoc: prepared.nextDoc,
			results: prepared.results,
			mutations: prepared.mutations,
			prepared,
		};
	}
	const validationScope = incrementalValidationScope(prevDoc, admitted);
	return evaluatePreparedMutationCandidate(prepared, lookupContext, {
		...(validationScope !== undefined && { validationScope }),
	});
}

export function mutationWireCanonicalityRejection(
	prevDoc: BlueprintDoc,
	error: MutationWireCanonicalityError,
): MutationCommitVerdict {
	return {
		ok: false,
		nextDoc: prevDoc,
		findings: [
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
 * `mutationCommitVerdict` is also absolute: it rejects unless the complete
 * candidate has zero shape, soundness, or completeness findings, including for
 * an empty batch. This separate boundary function exists because export
 * readiness additionally evaluates manifest-gated environment rules. With the
 * supplied manifest, media references are evaluated against the exact external
 * rows (including synthesized built-in icons) the caller proved. The real
 * export path threads the Project's complete external-resource snapshots
 * through `lib/export/boundaryValidation.ts`.
 */
export function exportReadinessFindings(
	doc: BlueprintDoc,
	lookupContext: LookupValidationContext,
	mediaAssets: Parameters<typeof evaluateBoundary>[1] = new Map(),
): ValidationError[] {
	return evaluateBoundary(doc, mediaAssets, lookupContext);
}

/**
 * Compose a rejection's findings into one person-to-person message — the
 * `{ error }` envelope the SA/MCP tool layer returns, and the prose the
 * builder's rejection notice shows. Each finding's `message` is already
 * a self-contained sentence naming what's wrong and where it lives; this
 * adds only the frame: nothing was changed, fix the edit and retry.
 */
export function describeCommitFindings(
	findings: readonly ValidationError[],
): string {
	const lines = findings.map((err) => `- ${err.message}`).join("\n");
	const plural = findings.length === 1 ? "a problem" : "problems";
	return `This change wasn't applied because the resulting app has ${plural}:\n${lines}\nNothing was changed. Fix ${
		findings.length === 1 ? "this problem" : "these problems"
	}, then try again.`;
}
