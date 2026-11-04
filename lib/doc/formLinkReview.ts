// lib/doc/formLinkReview.ts
//
// What an author must be told BEFORE a destination is added, moved,
// retargeted, or asked to carry values: pure verdicts over the document,
// derived from the same facts the validator and the wire read. Nothing here
// decides legality on its own: `formLinkTargetVerdict` restates the target
// rules (`FORM_LINK_TARGET_NOT_FOUND`, `FORM_LINK_SELF_REFERENCE`,
// `FORM_LINK_TARGET_NOT_OFFERED` and `FORM_LINK_SELECTION_CARDINALITY`) so a
// surface can refuse before it offers, and `formLinkCarryVerdict` asks the
// ONE projector the wire uses whether the destination's selection datums can
// be carried automatically (`FORM_LINK_DATUMS_INCOMPLETE`'s question, asked
// ahead of time). Destinations run in whatever order the author gives them,
// and link cycles are admitted, so neither a position nor a chain is refused.
// `__tests__/formLinkReview.test.ts` pins every `ok` against
// `mutationCommitVerdict`.
//
// Pure and cheap: every map is O(n²) over a form's links, and n is the
// number of destinations a person can name, not the number of cases.

import {
	entryFrameDatums,
	formLinkActionsBuildable,
	formLinkProjectionContext,
	formLinkTargetDatumIds,
	matchFrameToSource,
	owningModuleOf,
	targetFrameChildren,
	targetSelectionDatums,
} from "@/lib/commcare/formLinkProjection";
import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	caseSelectionCardinality,
	caseSelectionMaximum,
	type FormLink,
	type FormLinkTarget,
	formLinkSelectionIsCompatible,
	menuTargetOffered,
	moduleUuidOfForm,
	resolveFormLinkTarget,
	type Uuid,
} from "@/lib/domain";
import type { FormLinkDatumName } from "@/lib/domain/expression/types";
import { possibleFinalSessionCaseTypes } from "./caseOperationOrder";
import { afterSubmitPlan } from "./formLinkMutations";

/** Every position is admitted: each destination runs on its own condition. */
export type FormLinkMoveVerdict = { readonly ok: true };

/**
 * The move verdict for EVERY destination index of one link, so a pointer
 * drag and a keyboard move read one answer and cannot disagree. Index `i`
 * is the position the link would occupy after the move. Every index is
 * `ok`; the map is empty for a link that is not one of the form's
 * destinations.
 */
export function formLinkMoveVerdicts(
	doc: BlueprintDoc,
	formUuid: Uuid,
	uuid: Uuid,
): ReadonlyMap<number, FormLinkMoveVerdict> {
	const verdicts = new Map<number, FormLinkMoveVerdict>();
	const links = doc.forms[formUuid]?.formLinks ?? [];
	if (!links.some((link) => link.uuid === uuid)) return verdicts;
	for (let index = 0; index < links.length; index += 1) {
		verdicts.set(index, { ok: true });
	}
	return verdicts;
}

export type FormLinkTargetVerdict =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: "target-not-found" }
	/** A `form` target naming the source form; `this-form` is its spelling. */
	| { readonly ok: false; readonly reason: "self-target" }
	/** A submenu CommCare HQ's form settings page does not list from this
	 *  form's menu (`menuTargetOffered`). `parentUuid` is the menu that holds
	 *  it, which a link may open instead. */
	| {
			readonly ok: false;
			readonly reason: "not-offered";
			readonly menuUuid: Uuid;
			readonly parentUuid: Uuid | undefined;
	  }
	| {
			readonly ok: false;
			readonly reason: "selection-cardinality";
			readonly sourceCardinality: "single" | "multiple";
			readonly targetCardinality: "single" | "multiple";
			readonly sourceMaximum: number;
			readonly targetMaximum: number;
	  }
	| {
			readonly ok: false;
			readonly reason: "selection-case-type";
			readonly expectedCaseType: string;
			readonly possibleFinalCaseTypes: readonly string[];
	  };

/**
 * Whether a link on `formUuid`, a destination or the otherwise link, may
 * point at `target`. `datums` is the explicit datum map the proposed link
 * would store. When it is absent, the Builder first tries automatic
 * matching and falls back to the complete manual map its seed would
 * create; a destination is admitted only when that actual seed mode is
 * legal.
 */
export function formLinkTargetVerdict(
	doc: BlueprintDoc,
	formUuid: Uuid,
	target: FormLinkTarget,
	datums?: FormLink["datums"],
): FormLinkTargetVerdict {
	const proposed = formLinkTargetVerdictForDatumMode(
		doc,
		formUuid,
		target,
		datums !== undefined,
	);
	if (!proposed.ok || datums !== undefined) return proposed;

	return formLinkCarryVerdict(doc, formUuid, target).kind === "manual-required"
		? formLinkTargetVerdictForDatumMode(doc, formUuid, target, true)
		: proposed;
}

/**
 * Whether the carried values editor may replace automatic matching with an
 * explicit datum map. Collection-shaped selection must travel as one
 * collection, so an otherwise-compatible direct link can still refuse this
 * manual mode.
 */
export function formLinkManualCarryVerdict(
	doc: BlueprintDoc,
	formUuid: Uuid,
	target: FormLinkTarget,
): FormLinkTargetVerdict {
	return formLinkTargetVerdictForDatumMode(doc, formUuid, target, true);
}

/** The parent of `moduleUuid` when it names a menu that exists. */
function existingParentOf(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): Uuid | undefined {
	const parentUuid = doc.modules[moduleUuid]?.parentModuleUuid;
	return parentUuid !== undefined && doc.modules[parentUuid] !== undefined
		? parentUuid
		: undefined;
}

function formLinkTargetVerdictForDatumMode(
	doc: BlueprintDoc,
	formUuid: Uuid,
	target: FormLinkTarget,
	hasAuthoredDatums: boolean,
): FormLinkTargetVerdict {
	if (target.type === "form" && target.formUuid === formUuid) {
		return { ok: false, reason: "self-target" };
	}
	const resolved = resolveFormLinkTarget(doc, formUuid, target);
	if (resolved === undefined) return { ok: false, reason: "target-not-found" };
	const mod = doc.modules[resolved.moduleUuid];
	if (mod === undefined) return { ok: false, reason: "target-not-found" };
	const sourceModuleUuid = moduleUuidOfForm(doc, formUuid);

	if (resolved.type === "module") {
		/* A form in no menu has no menu for HQ's page to compare, so only a
		 * root menu, which the page always lists, is offered from it. */
		const offered =
			sourceModuleUuid === undefined
				? existingParentOf(doc, resolved.moduleUuid) === undefined
				: menuTargetOffered(doc, sourceModuleUuid, resolved.moduleUuid);
		return offered
			? { ok: true }
			: {
					ok: false,
					reason: "not-offered",
					menuUuid: resolved.moduleUuid,
					parentUuid: existingParentOf(doc, resolved.moduleUuid),
				};
	}

	const targetForm = doc.forms[resolved.formUuid];
	if (
		targetForm === undefined ||
		!(doc.formOrder[resolved.moduleUuid] ?? []).includes(resolved.formUuid)
	) {
		return { ok: false, reason: "target-not-found" };
	}
	const sourceForm = doc.forms[formUuid];
	const sourceModule =
		sourceModuleUuid === undefined ? undefined : doc.modules[sourceModuleUuid];
	if (sourceForm === undefined || sourceModule === undefined) {
		return { ok: true };
	}
	if (
		!formLinkSelectionIsCompatible({
			sourceModule,
			targetModule: mod,
			sourceLoadsCase: CASE_LOADING_FORM_TYPES.has(sourceForm.type),
			targetLoadsCase: CASE_LOADING_FORM_TYPES.has(targetForm.type),
			hasAuthoredDatums,
		})
	) {
		return {
			ok: false,
			reason: "selection-cardinality",
			sourceCardinality: caseSelectionCardinality(sourceModule),
			targetCardinality: caseSelectionCardinality(mod),
			sourceMaximum: caseSelectionMaximum(sourceModule),
			targetMaximum: caseSelectionMaximum(mod),
		};
	}
	if (
		CASE_LOADING_FORM_TYPES.has(sourceForm.type) &&
		CASE_LOADING_FORM_TYPES.has(targetForm.type) &&
		caseSelectionCardinality(sourceModule) === "multiple" &&
		mod.caseType !== undefined
	) {
		const possibleFinalCaseTypes = [
			...possibleFinalSessionCaseTypes(doc, formUuid),
		];
		if (possibleFinalCaseTypes.some((caseType) => caseType !== mod.caseType)) {
			return {
				ok: false,
				reason: "selection-case-type",
				expectedCaseType: mod.caseType,
				possibleFinalCaseTypes,
			};
		}
	}
	return { ok: true };
}

export interface FormLinkRequiredDatum {
	readonly name: FormLinkDatumName;
	readonly id: string;
	readonly caseType?: string;
}

/**
 * The selection datums a destination needs carried: the same derivation
 * the wire and `FORM_LINK_DATUMS_INCOMPLETE` use. Empty for a module target
 * (the person picks a case on arrival) and for a destination whose frame
 * cannot be derived (a form the actions builder would refuse; the commit
 * gate owns that).
 */
export function formLinkRequiredDatums(
	doc: BlueprintDoc,
	formUuid: Uuid,
	target: FormLinkTarget,
): readonly FormLinkRequiredDatum[] {
	/* Read the automatic-mode topology directly. The public target verdict
	 * asks this function which carry mode the Builder will seed, so routing
	 * that question back through it would recurse. */
	if (
		formLinkTargetVerdictForDatumMode(doc, formUuid, target, false).ok === false
	) {
		return [];
	}
	const resolved = resolveFormLinkTarget(doc, formUuid, target);
	if (resolved === undefined) return [];
	if (!formLinkActionsBuildable(doc, formUuid, [{ target }])) return [];
	const ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	const selections = new Map(
		targetSelectionDatums(doc, ctx, resolved).map((datum) => [datum.id, datum]),
	);
	return formLinkTargetDatumIds(doc, ctx, resolved).flatMap((datum) => {
		const name = datum.refs.find((ref) => ref.kind === "selected-case");
		if (name === undefined || name.kind !== "selected-case") return [];
		const caseType = selections.get(datum.id)?.caseType;
		return [
			{ name, id: datum.id, ...(caseType === undefined ? {} : { caseType }) },
		];
	});
}

export type FormLinkCarryVerdict =
	/** The destination selects nothing: it opens straight away (or the
	 *  person picks a case on a module's list). */
	| { readonly kind: "nothing-needed" }
	/** Every selection datum is satisfied by something this form's entry
	 *  already holds; `carried` names which source datum feeds which. */
	| {
			readonly kind: "automatic";
			readonly carried: readonly {
				readonly datumId: string;
				readonly sourceDatumId: string;
			}[];
	  }
	/** Something the destination selects has no source; the author must
	 *  work those values out by hand, or pick another destination. */
	| { readonly kind: "manual-required"; readonly datumIds: readonly string[] };

/**
 * Whether a link from `formUuid` to `target` can carry the destination's
 * selection datums automatically: HQ's `_get_datums_matched_to_source`
 * asked before the link exists, through the projector the wire uses.
 */
export function formLinkCarryVerdict(
	doc: BlueprintDoc,
	formUuid: Uuid,
	target: FormLinkTarget,
): FormLinkCarryVerdict {
	const required = formLinkRequiredDatums(doc, formUuid, target);
	if (required.length === 0) return { kind: "nothing-needed" };
	const resolved = resolveFormLinkTarget(doc, formUuid, target);
	const ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	const sourceModule = owningModuleOf(ctx, formUuid);
	if (sourceModule === undefined || resolved === undefined) {
		return { kind: "manual-required", datumIds: required.map((d) => d.id) };
	}
	const match = matchFrameToSource(
		targetFrameChildren(doc, ctx, resolved),
		entryFrameDatums(doc, ctx, sourceModule, formUuid),
	);
	if (match.unmatched.length > 0) {
		return {
			kind: "manual-required",
			datumIds: match.unmatched.map((datum) => datum.id),
		};
	}
	return {
		kind: "automatic",
		carried: match.matched.map((entry) => ({
			datumId: entry.id,
			sourceDatumId: entry.sourceId,
		})),
	};
}

export interface FormLinkAddChoices {
	/** "Go somewhere when a condition is true." */
	readonly conditional: { readonly ok: true };
	/** "Go somewhere every time." */
	readonly everyTime: { readonly ok: true };
	/** Where the form goes when no destination that may not run runs:
	 *  offered while some destination may not run and none is stored. */
	readonly otherwise:
		| { readonly ok: true }
		| { readonly ok: false; readonly reason: "otherwise-exists" }
		| { readonly ok: false; readonly reason: "otherwise-unreachable" };
}

/** Which kinds of destination the add control may offer on this form now. */
export function formLinkAddChoices(
	doc: BlueprintDoc,
	formUuid: Uuid,
): FormLinkAddChoices {
	const plan = afterSubmitPlan(doc, formUuid);
	return {
		conditional: { ok: true },
		everyTime: { ok: true },
		otherwise:
			plan?.otherwise !== undefined
				? { ok: false, reason: "otherwise-exists" }
				: plan?.otherwiseOffered === true
					? { ok: true }
					: { ok: false, reason: "otherwise-unreachable" },
	};
}
