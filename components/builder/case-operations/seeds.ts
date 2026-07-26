// components/builder/case-operations/seeds.ts
//
// Born-valid case operations, writes, and links.
//
// The app is valid by construction, so "add a change" cannot land a
// half-configured operation and let the author discover the rejection
// later. Each seed here is a complete operation the validator accepts on
// its own, which is why the add affordance asks WHAT the change does
// before it commits anything: the answer decides the action, the target,
// and which facets are legal (`caseOperations.ts::validateFacets`).
//
// `caseOperationCatalogMutations` declares a brand-new case type and any
// undeclared write property in the same batch, so a seed may name a type
// or property the catalog has not seen yet and still commit as one
// gated candidate.
//
// Seeds carry placeholder CONTENT (a create's case name), never
// placeholder STRUCTURE. The author edits the words; they never have to
// discover a missing required slot.

import { newUuid } from "@/components/builder/case-list-config/uuid";
import {
	type CaseOperation,
	type CaseOperationLink,
	type CaseOperationWrite,
	type CasePropertyDataType,
	type CaseTarget,
	humanizeId,
	type Uuid,
} from "@/lib/domain";
import {
	formField,
	isValueStorageAssignable,
	literal,
	now,
	term,
	today,
	type ValueExpression,
} from "@/lib/domain/predicate";

/** What an author is choosing when they add a change. */
export type CaseOperationSeedKind =
	| { readonly kind: "create"; readonly caseType: string }
	| { readonly kind: "update-session"; readonly caseType: string }
	| { readonly kind: "close-session"; readonly caseType: string };

/**
 * An XML-safe, form-unique slug for a new operation.
 *
 * The id is the author-facing handle the refusal copy and the wire both
 * use, so it starts from what the author just chose ("Create a referral"
 * → `create_referral`) rather than an opaque token.
 */
export function nextOperationId(
	base: string,
	taken: ReadonlySet<string>,
): string {
	const slug = base
		.toLocaleLowerCase()
		// Case types may legally contain hyphens; operation ids may not.
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^[^a-z_]+/, "")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "");
	const root = slug.length > 0 ? slug : "change";
	if (!taken.has(root)) return root;
	let suffix = 2;
	while (taken.has(`${root}_${suffix}`)) suffix += 1;
	return `${root}_${suffix}`;
}

/** The case name a fresh create carries until the author replaces it. */
function seededCaseName(caseType: string): ValueExpression {
	return term(literal(humanizeId(caseType)));
}

/**
 * One complete operation for the chosen intent.
 *
 * `create` is the only action that takes a `new` target, and it is the
 * only one that may carry a case name — the other two forbid both, so
 * each intent produces exactly the facets its action admits.
 */
export function seedCaseOperation(
	seed: CaseOperationSeedKind,
	takenIds: ReadonlySet<string>,
): CaseOperation {
	const uuid = newUuid();
	switch (seed.kind) {
		case "create":
			return {
				uuid,
				id: nextOperationId(`create_${seed.caseType}`, takenIds),
				action: "create",
				caseType: seed.caseType,
				target: { kind: "new" },
				name: seededCaseName(seed.caseType),
			};
		case "update-session":
			return {
				uuid,
				id: nextOperationId(`update_${seed.caseType}`, takenIds),
				action: "update",
				caseType: seed.caseType,
				target: { kind: "session" },
			};
		case "close-session":
			return {
				uuid,
				id: nextOperationId(`close_${seed.caseType}`, takenIds),
				action: "close",
				caseType: seed.caseType,
				target: { kind: "session" },
			};
	}
}

/**
 * A write of `property`, seeded with a value the commit gate accepts for
 * that property's own type.
 *
 * A STORED value is stricter than a compared one, and the difference is
 * exactly where a plausible-looking seed goes wrong: an empty temporal
 * literal compiles to SQL NULL here and blank text on the device, a text
 * literal cannot be stored as a multi-select, and a null is not a
 * portable clear on either. So the seed is not "an empty value of the
 * right type" — it is the first value that would actually submit.
 */
export function seedCaseOperationWrite(
	property: string,
	value: ValueExpression,
): CaseOperationWrite {
	return { property, value };
}

/**
 * The value a fresh write starts from, or `undefined` when this form
 * cannot yet fill one.
 *
 * A form answer comes first, because "save what they answered" is what a
 * write overwhelmingly means, and because for several types it is the
 * only storable value that exists: no literal can hold a multi-select or
 * a geopoint, and an empty temporal literal is not portable. When no
 * answer fits, a constant does — `today()` / `now()` for the temporal
 * types, a literal for the rest — and when neither exists the caller
 * offers the property with the reason rather than seeding something the
 * gate would refuse.
 */
export function seedWriteValue(
	dataType: CasePropertyDataType | undefined,
	formFields: readonly {
		readonly uuid: Uuid;
		readonly dataType: CasePropertyDataType | undefined;
	}[],
): ValueExpression | undefined {
	// An undeclared property is declared by this very batch, so any storable
	// value fits; text is the least surprising.
	if (dataType === undefined) return term(literal(""));

	const answer = formFields.find((field) =>
		isValueStorageAssignable(field.dataType ?? "text", dataType),
	);
	if (answer !== undefined) return term(formField(answer.uuid));

	switch (dataType) {
		case "text":
		case "single_select":
			return term(literal(""));
		case "int":
		case "decimal":
			return term(literal(0));
		case "date":
			return today();
		case "datetime":
			return now();
		default:
			// `time`, `multi_select`, and `geopoint` have no storable constant:
			// a literal cannot hold an array or a coordinate pair, and an empty
			// temporal is not portable. The form has to supply the value.
			return undefined;
	}
}

/** Why this form cannot start a write onto a property of `dataType`. */
export function writeSeedUnavailableReason(
	dataType: CasePropertyDataType,
): string {
	const answer =
		dataType === "multi_select"
			? "a multiple-choice question"
			: dataType === "geopoint"
				? "a location question"
				: "a time question";
	return `This form has no answer that can fill it. Add ${answer} first, or save to a different property.`;
}

/**
 * A link seeded as an UNLINK (`target: null`), which is the only shape
 * that is complete without asking a second question. Choosing what to
 * link to is the author's next step, and the row says so.
 *
 * `targetType` is the type at the OTHER end, so it must never default to
 * the operation's own case type: that would make the author's very next
 * click — pointing the link at the case this form opened — a type
 * mismatch caused by a default they never chose. The module's case type
 * is what the other end usually is, and what every legal target in the
 * picker resolves to.
 */
export function seedCaseOperationLink(
	identifier: string,
	targetType: string,
): CaseOperationLink {
	return { identifier, targetType, target: null, relationship: "child" };
}

/** A link identifier unique within one operation. */
export function nextLinkIdentifier(taken: ReadonlySet<string>): string {
	if (!taken.has("parent")) return "parent";
	let suffix = 2;
	while (taken.has(`parent_${suffix}`)) suffix += 1;
	return `parent_${suffix}`;
}

/**
 * The facets an action admits, applied to an existing operation.
 *
 * Changing the action is a real authoring gesture (an update that should
 * have been a close keeps its final property writes), so it re-shapes the
 * operation rather than refusing. Everything the destination action
 * forbids is dropped; the caller confirms first when that drops authored
 * content.
 */
export function reshapeForAction(
	operation: CaseOperation,
	action: CaseOperation["action"],
	fallbackTarget: CaseTarget,
	fallbackCaseType: string,
): CaseOperation {
	const base = {
		...operation,
		action,
		rename: undefined,
		retype: undefined,
		name: undefined,
		owner: undefined,
		links: operation.links,
	} satisfies CaseOperation;
	if (action === "create") {
		return stripUndefined({
			...base,
			target: { kind: "new" },
			name: operation.name ?? seededCaseName(operation.caseType),
			owner: operation.owner,
		});
	}
	const target: CaseTarget =
		operation.target.kind === "new" ? fallbackTarget : operation.target;
	const caseType =
		operation.target.kind === "new" ? fallbackCaseType : operation.caseType;
	if (action === "update") {
		return stripUndefined({
			...base,
			target,
			caseType,
			owner: operation.owner,
			rename: operation.rename,
			retype: operation.retype,
		});
	}
	// Close forbids owner, rename, retype, and links — but keeps its writes,
	// so "record the outcome and close" stays one operation.
	return stripUndefined({ ...base, target, caseType, links: undefined });
}

/** What changing to `action` would discard, in the author's words. */
export function actionChangeLosses(
	operation: CaseOperation,
	action: CaseOperation["action"],
): readonly string[] {
	const losses: string[] = [];
	if (action !== "create" && operation.target.kind === "new") {
		losses.push("the new case it makes");
	}
	if (action === "create" && operation.target.kind !== "new") {
		losses.push("the case it points at");
	}
	if (action !== "create" && operation.name !== undefined) {
		losses.push("the name it sets");
	}
	if (action === "close") {
		if (operation.owner !== undefined) losses.push("the owner it sets");
		if ((operation.links?.length ?? 0) > 0) losses.push("its links");
	}
	if (action !== "update" && operation.rename !== undefined) {
		losses.push("the new name it gives the case");
	}
	if (action !== "update" && operation.retype !== undefined) {
		losses.push("the type change");
	}
	return losses;
}

/** Drop explicitly-undefined keys so the stored object stays exact. */
function stripUndefined(operation: CaseOperation): CaseOperation {
	return Object.fromEntries(
		Object.entries(operation).filter(([, value]) => value !== undefined),
	) as CaseOperation;
}

/** Every operation id already in use, for slug uniqueness. */
export function takenOperationIds(
	operations: readonly CaseOperation[],
): ReadonlySet<string> {
	return new Set(operations.map((operation) => operation.id));
}

/** Every uuid this operation could name as an `op` target. */
export function priorCreateUuids(
	operations: readonly CaseOperation[],
	before: Uuid,
): readonly Uuid[] {
	const uuids: Uuid[] = [];
	for (const operation of operations) {
		if (operation.uuid === before) break;
		if (operation.action === "create") uuids.push(operation.uuid);
	}
	return uuids;
}
