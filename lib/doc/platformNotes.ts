/**
 * What the platform note row of one inspected owner states: the features of
 * the platform table (`lib/domain/platforms.ts`) its uses reach, read from
 * the one use detector (`lib/domain/platformUses.ts::platformFeatureUses`).
 *
 * Pure. The detector walks the whole document, so one snapshot's uses are
 * computed once and shared by every mounted note row (a WeakMap keyed by the
 * document snapshot, which a commit replaces).
 */

import {
	type BlueprintDoc,
	moduleOpensOnSearch,
	type Uuid,
} from "@/lib/domain";
import { walkExpressionTerms } from "@/lib/domain/expression";
import { formOfField } from "@/lib/domain/fieldForm";
import {
	PLATFORM_FEATURE_IDS,
	PLATFORM_FEATURES,
	type PlatformFeatureId,
} from "@/lib/domain/platforms";
import {
	type PlatformFeatureOwner,
	type PlatformFeatureUse,
	platformFeatureUses,
} from "@/lib/domain/platformUses";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import { expressionSlotValues } from "@/lib/domain/referenceSlots";

/** The features an expression leaf is: a note row beside a carrier of
 *  expressions states them as well as its own. */
export const EXPRESSION_PLATFORM_FEATURES: readonly PlatformFeatureId[] =
	PLATFORM_FEATURE_IDS.filter(
		(id) => PLATFORM_FEATURES[id].channel === "expression",
	);

const usesBySnapshot = new WeakMap<
	BlueprintDoc,
	readonly PlatformFeatureUse[]
>();

function usesOf(doc: BlueprintDoc): readonly PlatformFeatureUse[] {
	const held = usesBySnapshot.get(doc);
	if (held !== undefined) return held;
	const uses = platformFeatureUses(doc);
	usesBySnapshot.set(doc, uses);
	return uses;
}

/** Whether a use's owner is `owner`; a field owner also holds its options. */
function ownedBy(
	use: PlatformFeatureOwner,
	owner: PlatformFeatureOwner,
): boolean {
	switch (owner.kind) {
		case "app":
			return use.kind === "app";
		case "module":
			return use.kind === "module" && use.moduleUuid === owner.moduleUuid;
		case "form":
			return use.kind === "form" && use.formUuid === owner.formUuid;
		case "field":
			return (
				(use.kind === "field" || use.kind === "option") &&
				use.fieldUuid === owner.fieldUuid
			);
		case "option":
			return use.kind === "option" && use.optionUuid === owner.optionUuid;
		case "column":
			return use.kind === "column" && use.columnUuid === owner.columnUuid;
		case "search-input":
			return use.kind === "search-input" && use.inputUuid === owner.inputUuid;
		case "entry-point": {
			if (use.kind !== "entry-point") return false;
			const a = use.target;
			const b = owner.target;
			if (a.kind !== b.kind || a.moduleUuid !== b.moduleUuid) return false;
			return (
				a.kind !== "form" || (b.kind === "form" && a.formUuid === b.formUuid)
			);
		}
	}
}

/** The distinct features the owner's uses reach, in table order. */
export function platformFeaturesOf(
	doc: BlueprintDoc,
	owner: PlatformFeatureOwner,
): PlatformFeatureId[] {
	const seen = new Set<PlatformFeatureId>();
	for (const use of usesOf(doc))
		if (ownedBy(use.owner, owner)) seen.add(use.feature);
	return [...seen];
}

/**
 * Whether a question's own rules read a Search field (`#search/…`) in a form
 * of a module that opens on its search: where `search-first`'s Web Apps note
 * (a form opened from a link or an entry point reads each Search field's
 * starting value) changes what the read gives.
 */
export function readsSearchFieldInSearchFirstForm(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
): boolean {
	const formUuid = formOfField(doc, fieldUuid);
	if (formUuid === undefined) return false;
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	const module = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	if (module === undefined || !moduleOpensOnSearch(module)) return false;
	let reads = false;
	for (const value of expressionSlotValues(doc, {
		entity: "field",
		uuid: fieldUuid,
	})) {
		walkExpressionTerms(value.expression, (term) => {
			if (term.kind === "input") reads = true;
		});
		if (reads) return true;
	}
	return false;
}
