// lib/doc/casePlacements.ts
//
// Where CommCare HQ keeps each case change of a form, as the builder and the
// tools read it: a slot of the form's Case Management settings or a Save to
// Case block. The placement itself is decided by
// `lib/commcare/placement.ts::planPlacements`, which the wire reads too, so
// what the builder says is what the export writes. This is one of the
// allowlisted `lib/doc` consumers of `lib/commcare` in `biome.json`.
//
// Derived once per document object and form: documents are replaced, never
// changed in place.

import {
	type PlannedPlacement,
	planPlacements,
} from "@/lib/commcare/placement";
import {
	type BlueprintDoc,
	type CasePlacement,
	placementLine,
	type Uuid,
} from "@/lib/domain";

/** Which of HQ's two homes holds a case change. */
export type CasePlacementHome = "case-management" | "save-to-case";

export interface CasePlacementEntry {
	readonly placement: CasePlacement;
	readonly home: CasePlacementHome;
	/** The placement a published app recorded, kept because it still
	 *  expresses the change. */
	readonly held: boolean;
	/** The one line the builder shows under the change
	 *  (`placementCopy.ts::placementLine`). */
	readonly line: string;
	/** The operation whose place a close shares: a child case's close kept in
	 *  its create's subcase, or the own close kept with the own case. */
	readonly sharesWith?: Uuid;
}

export interface FormCasePlacementView {
	readonly formUuid: Uuid;
	/** Every case change of the form, in operation order, the own case
	 *  first. */
	readonly operations: readonly {
		readonly operationUuid: Uuid;
		readonly entry: CasePlacementEntry;
	}[];
	/** The form's own case. */
	readonly own?: CasePlacementEntry;
	/** The own close, only when it has a block of its own; a close kept with
	 *  the own case reads the own case's entry. */
	readonly ownClose?: CasePlacementEntry;
}

const views = new WeakMap<BlueprintDoc, Map<Uuid, FormCasePlacementView>>();

function entryOf(planned: PlannedPlacement): CasePlacementEntry {
	return {
		placement: planned.placement,
		home:
			planned.placement.kind === "save-to-case"
				? "save-to-case"
				: "case-management",
		held: planned.held,
		line: placementLine(planned.placement),
		...(planned.sharesWith !== undefined && {
			sharesWith: planned.sharesWith,
		}),
	};
}

/** Where CommCare HQ keeps each case change of `formUuid`. */
export function formCasePlacementView(
	doc: BlueprintDoc,
	formUuid: Uuid,
): FormCasePlacementView {
	let forms = views.get(doc);
	if (forms === undefined) {
		forms = new Map();
		views.set(doc, forms);
	}
	const known = forms.get(formUuid);
	if (known !== undefined) return known;
	const view = deriveView(doc, formUuid);
	forms.set(formUuid, view);
	return view;
}

function deriveView(doc: BlueprintDoc, formUuid: Uuid): FormCasePlacementView {
	const form = Object.hasOwn(doc.forms, formUuid)
		? doc.forms[formUuid]
		: undefined;
	if (form === undefined) return { formUuid, operations: [] };
	const { placements } = planPlacements(doc, formUuid);
	const operations: FormCasePlacementView["operations"][number][] = [];
	let own: CasePlacementEntry | undefined;
	for (const operation of form.caseOperations ?? []) {
		const planned = placements.get(operation.uuid);
		if (planned === undefined) continue;
		const entry = entryOf(planned);
		operations.push({ operationUuid: operation.uuid, entry });
		if (operation.action === "own") own = entry;
	}
	const close = placements.get("own-close");
	return {
		formUuid,
		operations,
		...(own !== undefined && { own }),
		...(close !== undefined &&
			close.sharesWith === undefined && { ownClose: entryOf(close) }),
	};
}
