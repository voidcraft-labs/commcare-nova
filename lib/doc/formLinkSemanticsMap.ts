// lib/doc/formLinkSemanticsMap.ts
//
// The one map from the after-submit links Nova stored when the first
// destination whose condition held was the only one that ran, to the links
// it stores now, when every destination whose condition holds runs and the
// otherwise is its own slot. The cutover's `form-link-semantics` step and
// the corpus sources call it; it is pure, total and idempotent.
//
// Its classes, in the order they apply:
//
//   L1  A destination that follows a conditional destination is given the
//       negation of every earlier conditional destination's condition, so
//       destinations that once excluded each other by position still do.
//   L2  A last destination with no condition after a conditional one (the
//       old "otherwise link") becomes the otherwise link.
//   L3  A stored `postSubmit` beside destinations becomes the built-in
//       otherwise when every destination has a condition (none for the app
//       home), and is removed when one has none, since it never ran.
//   L4  A link to a submenu CommCare HQ does not offer from the form's menu
//       is pointed at the nearest menu it does offer; where none is (the
//       submenu's parent is off the menu), the link is removed and the form
//       settled as `planFormLinkRemove` settles it.
//   L5  Carried values on a menu target, which reads none, are removed.
//   L6  A built-in otherwise the form's menu does not offer becomes the
//       nearest it does.
//
// L1 to L3 read each form's original destinations. The held-case guard
// changes no stored link: it is a property of emission.

import {
	type BlueprintDoc,
	type Form,
	type FormLink,
	type FormOtherwise,
	formLinkMayNotRun,
	menuTargetOffered,
	moduleUuidOfForm,
	nearestOfferedMenu,
	type OtherwiseDestination,
	otherwiseDestinationsOffered,
	type PostSubmitDestination,
	postSubmitDestinationsOffered,
	type Uuid,
} from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import { deepEqual } from "./deepEqual";

export type FormLinkSemanticsChange =
	| {
			readonly kind: "conditions-written";
			readonly formUuid: Uuid;
			readonly linkUuids: readonly Uuid[];
	  }
	| {
			readonly kind: "otherwise-set";
			readonly formUuid: Uuid;
			readonly otherwise: FormOtherwise;
			/** L6: the built-in destination it replaced, which the menu does not offer. */
			readonly from?: OtherwiseDestination;
	  }
	| {
			readonly kind: "after-submit-dropped";
			readonly formUuid: Uuid;
			readonly destination: PostSubmitDestination;
	  }
	| {
			readonly kind: "target-moved";
			readonly formUuid: Uuid;
			readonly linkUuid: Uuid;
			readonly from: Uuid;
			readonly to: Uuid;
	  }
	| {
			readonly kind: "datums-dropped";
			readonly formUuid: Uuid;
			readonly linkUuid: Uuid;
			readonly to: Uuid;
	  }
	/** A link to a submenu HQ does not offer whose parent is off the menu,
	 *  removed; `to` is the submenu it opened. */
	| {
			readonly kind: "link-removed";
			readonly formUuid: Uuid;
			readonly linkUuid: Uuid;
			readonly to: Uuid;
	  };

/** The after-submit slots of one form, as the map rewrites them. */
interface AfterSubmitSlots {
	formLinks: FormLink[] | undefined;
	otherwise: FormOtherwise | undefined;
	postSubmit: PostSubmitDestination | undefined;
}

/** The built-in destinations nearest to an unoffered one, in the order L6
 *  tries them; `firstMenu` is offered to every form in a menu. */
const NEAREST_BUILT_IN: readonly OtherwiseDestination[] = [
	"module",
	"parentMenu",
	"firstMenu",
];

/**
 * Whether `condition`'s last clauses already negate every earlier
 * conditional destination, so the destination excludes each of them and L1
 * has nothing to write. A negated clause matches an earlier destination
 * when it negates that destination's whole condition or, where that
 * condition is a conjunction, its first clause; either negation implies the
 * earlier condition is false. This is what makes L1 idempotent: the
 * condition L1 writes for a destination begins with its original
 * condition, which a later destination's written condition negates.
 */
function alreadyExclusive(
	condition: Expression,
	earlier: readonly Expression[],
): boolean {
	if (condition.kind !== "and") return false;
	const clauses = condition.clauses;
	if (clauses.length < earlier.length + 1) return false;
	const tail = clauses.slice(clauses.length - earlier.length);
	return earlier.every((prior, index) => {
		const clause = tail[index];
		if (clause?.kind !== "not") return false;
		return (
			deepEqual(clause.clause, prior) ||
			(prior.kind === "and" && deepEqual(clause.clause, prior.clauses[0]))
		);
	});
}

/** L1 to L3 over one form's original destinations. */
function mapOriginalLinks(
	formUuid: Uuid,
	slots: AfterSubmitSlots,
	changes: FormLinkSemanticsChange[],
): void {
	const original = slots.formLinks;
	if (original === undefined) return;

	// L1: each conditional destination that follows a conditional one
	// conjoins the negation of every earlier conditional destination's
	// original condition, built directly so each original condition stays
	// one clause. A last unconditional destination is L2's. An unconditional
	// destination before the last ran every time and blocked the rest, a
	// shape no app holds, and is left as it is.
	const last = original.at(-1);
	const takesL2 =
		slots.otherwise === undefined &&
		last !== undefined &&
		last.condition === undefined &&
		original.slice(0, -1).some((link) => link.condition !== undefined);
	const written: Uuid[] = [];
	const earlier: Expression[] = [];
	const mapped = original.map((link): FormLink => {
		const priors = [...earlier];
		if (link.condition !== undefined) earlier.push(link.condition);
		const condition = link.condition;
		if (condition === undefined || priors.length === 0) return link;
		if (alreadyExclusive(condition, priors)) return link;
		written.push(link.uuid);
		const clauses: [Expression, ...Expression[]] = [
			condition,
			...priors.map((prior): Expression => ({ kind: "not", clause: prior })),
		];
		return { ...link, condition: { kind: "and", clauses } };
	});
	if (written.length > 0) {
		changes.push({ kind: "conditions-written", formUuid, linkUuids: written });
	}

	// L2: the last unconditional destination after a conditional one is the
	// otherwise link, with its uuid, target and carried values.
	let destinations = mapped;
	if (takesL2 && last !== undefined) {
		destinations = mapped.slice(0, -1);
		const otherwise: FormOtherwise = {
			kind: "link",
			uuid: last.uuid,
			target: last.target,
			...(last.datums !== undefined && { datums: last.datums }),
		};
		slots.otherwise = otherwise;
		changes.push({ kind: "otherwise-set", formUuid, otherwise });
		if (slots.postSubmit !== undefined) {
			changes.push({
				kind: "after-submit-dropped",
				formUuid,
				destination: slots.postSubmit,
			});
			slots.postSubmit = undefined;
		}
	}
	slots.formLinks = destinations;

	// L3: a stored after-submit beside destinations. When every original
	// destination has a condition it ran when none held, which is the
	// otherwise; the app home is an absent otherwise. When one has none it
	// never ran.
	const stored = slots.postSubmit;
	if (stored === undefined) return;
	slots.postSubmit = undefined;
	if (original.every((link) => link.condition !== undefined)) {
		if (stored === "app_home") return;
		const otherwise: FormOtherwise = {
			kind: "destination",
			destination: stored,
		};
		slots.otherwise = otherwise;
		changes.push({ kind: "otherwise-set", formUuid, otherwise });
		return;
	}
	changes.push({ kind: "after-submit-dropped", formUuid, destination: stored });
}

/** The document `slots` would make, with `formUuid`'s slots replaced. */
function withSlots(
	doc: BlueprintDoc,
	forms: Record<Uuid, Form>,
	formUuid: Uuid,
	slots: AfterSubmitSlots,
): BlueprintDoc {
	forms[formUuid] = formWithSlots(forms[formUuid], slots);
	return { ...doc, forms };
}

function formWithSlots(form: Form, slots: AfterSubmitSlots): Form {
	const {
		formLinks: _links,
		otherwise: _otherwise,
		postSubmit: _postSubmit,
		...rest
	} = form;
	return {
		...rest,
		...(slots.postSubmit !== undefined && { postSubmit: slots.postSubmit }),
		...(slots.formLinks !== undefined &&
			slots.formLinks.length > 0 && { formLinks: slots.formLinks }),
		...(slots.otherwise !== undefined && { otherwise: slots.otherwise }),
	} as Form;
}

/** The first of `ladder` that `offered` holds, else `firstMenu`. */
function nearestBuiltIn(
	offered: readonly PostSubmitDestination[],
): OtherwiseDestination {
	return NEAREST_BUILT_IN.find((d) => offered.includes(d)) ?? "firstMenu";
}

/**
 * L4 over one form: retarget each link to an unoffered submenu, or remove
 * it where no offered menu holds it, then settle the form as
 * `planFormLinkRemove` does when a removal happened.
 */
function mapUnofferedMenus(
	doc: BlueprintDoc,
	forms: Record<Uuid, Form>,
	formUuid: Uuid,
	sourceModuleUuid: Uuid,
	slots: AfterSubmitSlots,
	changes: FormLinkSemanticsChange[],
): void {
	let removed = false;
	const retarget = <L extends { uuid: Uuid; target: FormLink["target"] }>(
		link: L,
	): L | undefined => {
		const target = link.target;
		if (target.type !== "module") return link;
		if (menuTargetOffered(doc, sourceModuleUuid, target.moduleUuid))
			return link;
		const to = nearestOfferedMenu(doc, sourceModuleUuid, target.moduleUuid);
		if (to === undefined) {
			if (doc.modules[target.moduleUuid] === undefined) return link;
			removed = true;
			changes.push({
				kind: "link-removed",
				formUuid,
				linkUuid: link.uuid,
				to: target.moduleUuid,
			});
			return undefined;
		}
		changes.push({
			kind: "target-moved",
			formUuid,
			linkUuid: link.uuid,
			from: target.moduleUuid,
			to,
		});
		return { ...link, target: { type: "module", moduleUuid: to } };
	};

	const hadDestinations = (slots.formLinks?.length ?? 0) > 0;
	slots.formLinks = slots.formLinks?.flatMap((link) => {
		const next = retarget(link);
		return next === undefined ? [] : [next];
	});
	if (slots.otherwise?.kind === "link") {
		slots.otherwise = retarget(slots.otherwise);
	}
	if (!removed) return;

	// Settle the form as `planFormLinkRemove` settles a removal.
	const destinations = slots.formLinks ?? [];
	if (hadDestinations && destinations.length === 0) {
		const otherwise = slots.otherwise;
		slots.otherwise = undefined;
		if (otherwise?.kind === "destination") {
			const offered = postSubmitDestinationsOffered(
				withSlots(doc, { ...forms }, formUuid, slots),
				formUuid,
			);
			slots.postSubmit = offered.includes(otherwise.destination)
				? otherwise.destination
				: nearestBuiltIn(offered);
		} else if (otherwise?.kind === "link") {
			slots.formLinks = [
				{
					uuid: otherwise.uuid,
					target: otherwise.target,
					...(otherwise.datums !== undefined && { datums: otherwise.datums }),
				},
			];
		}
		return;
	}
	if (slots.otherwise === undefined || destinations.length === 0) return;
	const candidate = withSlots(doc, { ...forms }, formUuid, slots);
	if (
		!destinations.some((link) => formLinkMayNotRun(candidate, formUuid, link))
	) {
		slots.otherwise = undefined;
	}
}

/** L5 over one form: a menu target carries no values. */
function mapMenuDatums(
	formUuid: Uuid,
	slots: AfterSubmitSlots,
	changes: FormLinkSemanticsChange[],
): void {
	const strip = <
		L extends { uuid: Uuid; target: FormLink["target"]; datums?: unknown },
	>(
		link: L,
	): L => {
		if (link.target.type !== "module" || link.datums === undefined) return link;
		changes.push({
			kind: "datums-dropped",
			formUuid,
			linkUuid: link.uuid,
			to: link.target.moduleUuid,
		});
		const { datums: _datums, ...rest } = link;
		return rest as L;
	};
	slots.formLinks = slots.formLinks?.map(strip);
	if (slots.otherwise?.kind === "link")
		slots.otherwise = strip(slots.otherwise);
}

/** L6 over one form: a built-in otherwise its menu offers. */
function mapUnofferedOtherwise(
	doc: BlueprintDoc,
	formUuid: Uuid,
	slots: AfterSubmitSlots,
	changes: FormLinkSemanticsChange[],
): void {
	const otherwise = slots.otherwise;
	if (otherwise?.kind !== "destination") return;
	const offered = otherwiseDestinationsOffered(doc, formUuid);
	if (offered.includes(otherwise.destination)) return;
	const next: FormOtherwise = {
		kind: "destination",
		destination: nearestBuiltIn(offered),
	};
	slots.otherwise = next;
	changes.push({
		kind: "otherwise-set",
		formUuid,
		otherwise: next,
		from: otherwise.destination,
	});
}

/** Every form, the ones in a menu first in menu order, then the rest. */
function formsInOrder(doc: BlueprintDoc): Uuid[] {
	const ordered = doc.moduleOrder.flatMap(
		(moduleUuid) => doc.formOrder[moduleUuid] ?? [],
	);
	const seen = new Set(ordered);
	return [
		...ordered.filter((uuid) => doc.forms[uuid] !== undefined),
		...(Object.keys(doc.forms) as Uuid[]).filter((uuid) => !seen.has(uuid)),
	];
}

/** Defect 26's map over a document parsed by the head schema: L1 to L6, in
 *  that order, each form's L1 to L3 computed over its original link list.
 *  Total and idempotent: a second application returns no change. */
export function mapFormLinkSemantics(doc: BlueprintDoc): {
	readonly doc: BlueprintDoc;
	readonly changes: readonly FormLinkSemanticsChange[];
} {
	const changes: FormLinkSemanticsChange[] = [];
	const order = formsInOrder(doc);
	const slotsOf = new Map<Uuid, AfterSubmitSlots>();
	for (const formUuid of order) {
		const form = doc.forms[formUuid];
		if (form === undefined) continue;
		if (form.formLinks === undefined && form.otherwise === undefined) continue;
		slotsOf.set(formUuid, {
			formLinks: form.formLinks?.map((link) => ({ ...link })),
			otherwise: form.otherwise,
			postSubmit: form.postSubmit,
		});
	}
	if (slotsOf.size === 0) return { doc, changes };

	const forms: Record<Uuid, Form> = { ...doc.forms };
	const current = (): BlueprintDoc => {
		const { refIndex: _refIndex, ...rest } = doc;
		return { ...rest, forms: { ...forms } } as BlueprintDoc;
	};
	const settle = (formUuid: Uuid, slots: AfterSubmitSlots) => {
		forms[formUuid] = formWithSlots(doc.forms[formUuid], slots);
	};

	for (const [formUuid, slots] of slotsOf) {
		mapOriginalLinks(formUuid, slots, changes);
		settle(formUuid, slots);
	}
	for (const [formUuid, slots] of slotsOf) {
		const sourceModuleUuid = moduleUuidOfForm(doc, formUuid);
		if (sourceModuleUuid === undefined) continue;
		mapUnofferedMenus(
			current(),
			forms,
			formUuid,
			sourceModuleUuid,
			slots,
			changes,
		);
		settle(formUuid, slots);
	}
	for (const [formUuid, slots] of slotsOf) {
		mapMenuDatums(formUuid, slots, changes);
		settle(formUuid, slots);
	}
	for (const [formUuid, slots] of slotsOf) {
		if (moduleUuidOfForm(doc, formUuid) === undefined) continue;
		mapUnofferedOtherwise(current(), formUuid, slots, changes);
		settle(formUuid, slots);
	}
	/* A change list can be empty while the document changed: an app-home
	 * after-submit beside conditional destinations leaves the slot with no
	 * notice, since the worker still goes home. */
	const changed = [...slotsOf.keys()].some(
		(formUuid) =>
			forms[formUuid] !== doc.forms[formUuid] &&
			!deepEqual(forms[formUuid], doc.forms[formUuid]),
	);
	return changed ? { doc: current(), changes } : { doc, changes };
}
