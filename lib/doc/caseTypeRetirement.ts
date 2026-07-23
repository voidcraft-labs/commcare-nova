/**
 * Orphaned case-type-record retirement — what keeps "stop tracking this
 * case type" satisfiable under the single commit rule.
 *
 * Removing a case type's owning module — or retyping it via a module
 * case-type change — leaves the record with no owning module. When
 * other modules' forms still WRITE the type, that state IS a finding
 * (`MISSING_CHILD_CASE_MODULE` keys on writers), and a batch that
 * introduces it would be rejected with guidance opposite to the user's
 * intent ("add a module with case_type X" when the user is deleting X).
 * The cascade here resolves that: when the displaced type's record
 * would be left module-less AND nothing else in the doc references the
 * type, the same batch retires the record (a stale record would
 * otherwise linger as dead plan state); when references remain, the
 * planner reports them so the rejection names a repair the user can
 * actually perform.
 *
 * The cascade is emitted as EXPLICIT mutations by the batch-building
 * surfaces (the SA/MCP `removeModule` / `updateModule` tools and the
 * builder's mutation hook) — never as a `removeModule` reducer side
 * effect. Reducers replay historical event logs byte-for-byte: a
 * reducer-level cascade would make an old `removeModule` event reduce
 * to a different doc than the one its clients saw when it was written.
 *
 * "References" are the slots that NAME the case type:
 *   - another case-type record declaring it as `parent_type`;
 *   - a field's `case_property_on` (the field writes to it);
 *   - a `#<type>/<prop>` hashtag in any XPath or prose slot
 *     (the reference-slot registry enumerates them; XPath surfaces are
 *     read through the Lezer grammar, prose through the shared
 *     bare-hashtag matcher);
 *   - a predicate/expression AST leaf whose `PropertyRef.caseType` or
 *     relation-walk hints (`throughCaseType` / `ofCaseType`) name it,
 *     and a simple search input whose `via` hints name it.
 * Contextual property names (a case-list column's `field`, a simple
 * search input's `property`) follow the module's CURRENT case type and
 * never name a type themselves, so they are not retirement blockers —
 * the validator's own property rules adjudicate them on the same batch.
 */

import {
	orderedFieldUuids,
	orderedFormUuids,
	orderedModuleUuids,
} from "@/lib/doc/fieldWalk";
import {
	findContainingForm,
	findFieldParent,
} from "@/lib/doc/mutations/helpers";
import { referencingCarrierUuids } from "@/lib/doc/referenceIndex";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Field, Form, Module, Uuid } from "@/lib/domain";
import {
	caseTypeTargetKey,
	FORM_REFERENCE_SLOTS,
	fieldReferenceSlotsFor,
	isXPathExpression,
	MODULE_REFERENCE_SLOTS,
	readSlotStrings,
	readSlotValues,
	xpathRefParts,
} from "@/lib/domain";
import {
	type Predicate,
	type RelationPath,
	type Term,
	type ValueExpression,
	walkExpressionNodes,
	walkExpressionPredicateNodes,
	walkExpressionTerms,
	walkPredicateExpressionNodes,
	walkPredicateNodes,
	walkTerms,
} from "@/lib/domain/predicate";
import { transformBareHashtags } from "@/lib/preview/engine/labelRefs";

// ── Outcome shape ───────────────────────────────────────────────────────

/** A blocked retirement's reference site, rendered for TWO audiences:
 *  `verbose` keeps the wire spelling the SA self-corrects on (the raw
 *  `case_property_on` slot key, the literal `#<type>/…` hashtag);
 *  `concise` is the jargon-free line the builder toast shows. Equal for
 *  sites that never carried wire vocabulary (the case type name itself is
 *  a user concept). */
interface RetirementReference {
	verbose: string;
	concise: string;
}

/** A reference site whose description is identical for both audiences. */
const sameRef = (line: string): RetirementReference => ({
	verbose: line,
	concise: line,
});

/** Friendly names for the reference-slot registry keys, for the CONCISE
 *  (builder-toast) reference lines only. The verbose SA line keeps the raw
 *  slot key (`repeat_count`, `validate_msg`, …); the user never sees those
 *  wire-internal names. Any key not mapped falls back to its spaced form so
 *  a new slot can't leak an underscored key into the toast. */
const SLOT_LABEL: Readonly<Record<string, string>> = {
	relevant: "display condition",
	validate: "validation rule",
	validate_msg: "validation message",
	calculate: "calculation",
	default_value: "default value",
	required: "required rule",
	repeat_count: "repeat count",
	ids_query: "list of records",
	label: "label",
	hint: "hint",
	help: "help text",
	option_label: "option label",
	form_display_condition: "display condition",
	module_display_condition: "display condition",
	form_link_condition: "follow-on link condition",
	form_link_datum_xpath: "follow-on link value",
	assessment_user_score: "Connect score",
	deliver_entity_id: "Connect entity ID",
	deliver_entity_name: "Connect entity name",
};

const slotLabel = (slot: string): string =>
	SLOT_LABEL[slot] ?? slot.replace(/_/g, " ");

/** The cascade decision for a batch that displaces a module's case type. */
export type CaseTypeRetirement =
	/** No record is being orphaned — the batch needs no cascade. */
	| { kind: "none" }
	/** The displaced type's record is orphaned and unreferenced — append
	 *  `mutations` to the same batch to retire it. */
	| { kind: "retire"; caseType: string; mutations: Mutation[] }
	/** The displaced type's record is orphaned but still referenced —
	 *  the batch must not run. `message` names every reference and the
	 *  repair for the SA (wire spelling intact); `userMessage` is the same
	 *  frame in the concise builder voice. */
	| {
			kind: "blocked";
			caseType: string;
			references: string[];
			message: string;
			userMessage: string;
	  };

/**
 * The cascade decision for removing `moduleUuid` wholesale. The removed
 * module's own subtree goes with it, so its contents never count as
 * references.
 */
export function planCaseTypeRetirementOnRemove(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): CaseTypeRetirement {
	const mod = doc.modules[moduleUuid];
	if (!mod) return { kind: "none" };
	return planRetirement(doc, moduleUuid, mod, {
		excludeModuleContent: true,
		action: `Removing module "${mod.name}"`,
	});
}

/**
 * The cascade decision for changing `moduleUuid`'s case type to
 * `nextCaseType` (`undefined` clears it). The module and its forms
 * REMAIN, so their references to the displaced type block the
 * retirement (they'd dangle).
 */
export function planCaseTypeRetirementOnRetype(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	nextCaseType: string | undefined,
): CaseTypeRetirement {
	const mod = doc.modules[moduleUuid];
	if (!mod || mod.caseType === nextCaseType) return { kind: "none" };
	return planRetirement(doc, moduleUuid, mod, {
		excludeModuleContent: false,
		action:
			nextCaseType !== undefined
				? `Changing module "${mod.name}" to case type "${nextCaseType}"`
				: `Clearing module "${mod.name}"'s case type`,
	});
}

function planRetirement(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	mod: Module,
	opts: { excludeModuleContent: boolean; action: string },
): CaseTypeRetirement {
	const displaced = mod.caseType;
	if (!displaced) return { kind: "none" };
	const record = doc.caseTypes?.find((ct) => ct.name === displaced);
	if (!record) return { kind: "none" };

	/* Another module still manages the type → the record keeps its owner
	 * and nothing is orphaned. */
	const otherOwner = doc.moduleOrder.some(
		(uuid) => uuid !== moduleUuid && doc.modules[uuid]?.caseType === displaced,
	);
	if (otherOwner) return { kind: "none" };

	const references = findCaseTypeReferences(doc, displaced, {
		excludeModuleUuid: opts.excludeModuleContent ? moduleUuid : undefined,
	});
	if (references.length > 0) {
		return {
			kind: "blocked",
			caseType: displaced,
			// The field keeps the verbose strings (SA / introspection); the
			// two renderings differ only in the per-reference lines.
			references: references.map((r) => r.verbose),
			message: blockedRetirementMessage(
				opts.action,
				displaced,
				references.map((r) => r.verbose),
			),
			userMessage: userBlockedRetirementMessage(
				opts.action,
				displaced,
				references.map((r) => r.concise),
			),
		};
	}

	return {
		kind: "retire",
		caseType: displaced,
		// Granular `retireCaseType` keyed by name (the reducer canonicalizes an
		// emptied catalog to `null`), so a concurrent edit to a DIFFERENT type
		// merges rather than being clobbered by a wholesale `setCaseTypes`.
		mutations: [{ kind: "retireCaseType", caseType: displaced }],
	};
}

/** The SA / introspection rejection — what was tried, why it can't run,
 *  and the repair, in the verbose voice (the reference lines keep their
 *  wire spelling). */
function blockedRetirementMessage(
	action: string,
	caseType: string,
	references: string[],
): string {
	const lines = references.map((r) => `  • ${r}`).join("\n");
	return (
		`${action} would retire its case type "${caseType}" — no other module manages it — ` +
		`but ${references.length === 1 ? "something still references" : `${references.length} things still reference`} "${caseType}":\n` +
		`${lines}\n` +
		`Remove or retarget ${references.length === 1 ? "that reference" : "those references"} first, or keep a module that manages "${caseType}".`
	);
}

/** The builder-toast twin of {@link blockedRetirementMessage}: the same
 *  facts and the same concise reference list, framed in plain English —
 *  no "retire" / "manages" / "retarget", which read as internal jargon to
 *  a person. */
function userBlockedRetirementMessage(
	action: string,
	caseType: string,
	references: string[],
): string {
	const lines = references.map((r) => `  • ${r}`).join("\n");
	const one = references.length === 1;
	return (
		`${action} would leave the "${caseType}" case type with no module. ` +
		`${one ? "Something" : `${references.length} things`} still ${one ? "uses" : "use"} it:\n` +
		`${lines}\n` +
		`${one ? "Update or remove that first" : "Update or remove those first"}, or keep a module for "${caseType}".`
	);
}

// ── Reference scan ──────────────────────────────────────────────────────

/**
 * Every site in the doc that names `caseType`, as person-readable
 * descriptions. `excludeModuleUuid` skips one module's whole subtree
 * (forms + fields + case-list/search config) — the module a removal is
 * deleting, whose contents go with it.
 *
 * The carriers come from ONE reference-index lookup on the case type's
 * name — never a doc walk. The index's `t:` bucket holds exactly the
 * type-NAMING reference classes this planner adjudicates (a field's
 * `case_property_on`, explicit `#<type>/…` hashtags in XPath and
 * prose, AST origin types and relation-walk hints) and deliberately
 * excludes the contextual shapes that follow a module's current type
 * (`#case/…`, column `field`s, simple search-input properties). The
 * per-entity collectors below then re-derive each carrier's
 * person-readable descriptions — re-parsing only the named carrier's
 * own slots — and the module's own `case_type` slot edge contributes
 * nothing because the module collector treats ownership as the
 * planner's other-owner check's concern, not a reference.
 *
 * The catalog's `parent_type` links stay a direct read of the
 * root-level `doc.caseTypes` array — the registry's owning entities
 * are field / form / module, so the catalog has no carrier uuid to
 * index under.
 */
function findCaseTypeReferences(
	doc: BlueprintDoc,
	caseType: string,
	opts: { excludeModuleUuid?: Uuid } = {},
): RetirementReference[] {
	const references: RetirementReference[] = [];

	for (const ct of doc.caseTypes ?? []) {
		if (ct.name !== caseType && ct.parent_type === caseType) {
			references.push(
				sameRef(`case type "${ct.name}" declares "${caseType}" as its parent`),
			);
		}
	}

	/* The blocked-verdict list reads in document order (modules in
	 * `moduleOrder`, a module's own config before its forms, forms in
	 * order, fields depth-first), so the looked-up carriers are placed
	 * and sorted before their descriptions render. A carrier that can't
	 * be placed (not reachable through the order arrays) is skipped —
	 * the walk this lookup replaced never visited those either. */
	const scanIndex = buildCarrierScanIndex(doc);
	const placed: CarrierPlacement[] = [];
	for (const carrierUuid of referencingCarrierUuids(
		doc,
		caseTypeTargetKey(caseType),
	)) {
		const placement = placeCarrier(doc, carrierUuid as Uuid, scanIndex);
		if (!placement) continue;
		if (placement.moduleUuid === opts.excludeModuleUuid) continue;
		placed.push(placement);
	}
	placed.sort((a, b) => compareRanks(a.rank, b.rank));

	for (const { uuid, moduleUuid } of placed) {
		const mod = doc.modules[moduleUuid];
		if (!mod) continue;
		if (uuid === moduleUuid) {
			collectModuleConfigReferences(mod, caseType, references);
			continue;
		}
		const field = doc.fields[uuid];
		if (field) {
			const formUuid = findContainingForm(doc, uuid);
			const form = formUuid !== undefined ? doc.forms[formUuid] : undefined;
			if (!form) continue;
			const where = `form "${form.name}" (module "${mod.name}")`;
			collectFieldReferences(field, caseType, where, references);
			continue;
		}
		const form = doc.forms[uuid];
		if (form) {
			const where = `form "${form.name}" (module "${mod.name}")`;
			collectFormSlotReferences(form, caseType, where, references);
		}
	}

	return references;
}

/** One looked-up carrier, placed in document order. `rank` compares
 *  lexicographically: `[moduleIndex, -1]` for the module's own config,
 *  `[moduleIndex, formIndex, -1]` for a form's wiring, and
 *  `[moduleIndex, formIndex, ...childIndices]` for a field — so a
 *  module's config precedes its forms, a form's wiring precedes its
 *  fields, and fields read depth-first (a container before its
 *  children), exactly the order the doc walk used to produce. */
interface CarrierPlacement {
	uuid: Uuid;
	moduleUuid: Uuid;
	rank: number[];
}

function compareRanks(a: readonly number[], b: readonly number[]): number {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return a.length - b.length;
}

/** A form's DISPLAY position within the app: its owning module's uuid +
 *  sorted module index + the form's sorted index within that module. */
interface FormPosition {
	moduleUuid: Uuid;
	moduleIndex: number;
	formIndex: number;
}

/** Sorted-position lookups built ONCE per scan and threaded through every
 *  `placeCarrier` call, so a heavily-referenced type doesn't re-sort the whole
 *  module list (and each module's forms) per referencing carrier. */
interface CarrierScanIndex {
	moduleIndex: ReadonlyMap<Uuid, number>;
	formPosition: ReadonlyMap<Uuid, FormPosition>;
}

/** Walk the sorted module + form sequences ONCE, indexing every module's and
 *  form's DISPLAY position (`sort-by-(order, uuid)`). */
function buildCarrierScanIndex(doc: BlueprintDoc): CarrierScanIndex {
	const moduleIndex = new Map<Uuid, number>();
	const formPosition = new Map<Uuid, FormPosition>();
	const moduleUuids = orderedModuleUuids(doc);
	for (let mi = 0; mi < moduleUuids.length; mi++) {
		const moduleUuid = moduleUuids[mi];
		moduleIndex.set(moduleUuid, mi);
		const formUuids = orderedFormUuids(doc, moduleUuid);
		for (let fi = 0; fi < formUuids.length; fi++) {
			formPosition.set(formUuids[fi], {
				moduleUuid,
				moduleIndex: mi,
				formIndex: fi,
			});
		}
	}
	return { moduleIndex, formPosition };
}

function placeCarrier(
	doc: BlueprintDoc,
	uuid: Uuid,
	index: CarrierScanIndex,
): CarrierPlacement | undefined {
	if (doc.modules[uuid]) {
		const moduleIndex = index.moduleIndex.get(uuid);
		if (moduleIndex === undefined) return undefined;
		return { uuid, moduleUuid: uuid, rank: [moduleIndex, -1] };
	}
	if (doc.forms[uuid]) {
		const position = index.formPosition.get(uuid);
		if (!position) return undefined;
		return {
			uuid,
			moduleUuid: position.moduleUuid,
			rank: [position.moduleIndex, position.formIndex, -1],
		};
	}
	if (doc.fields[uuid]) {
		// Climb to the containing form collecting each level's DISPLAY (sorted)
		// sibling index — the depth-first rank within the form. Sequence is
		// `sort-by-(order, uuid)`, not array position.
		const childIndices: number[] = [];
		let cursor: Uuid = uuid;
		const seen = new Set<Uuid>();
		while (!seen.has(cursor)) {
			seen.add(cursor);
			const parent = findFieldParent(doc, cursor);
			if (!parent) return undefined;
			childIndices.unshift(
				orderedFieldUuids(doc, parent.parentUuid).indexOf(cursor),
			);
			if (doc.forms[parent.parentUuid]) {
				const position = index.formPosition.get(parent.parentUuid);
				if (!position) return undefined;
				return {
					uuid,
					moduleUuid: position.moduleUuid,
					rank: [position.moduleIndex, position.formIndex, ...childIndices],
				};
			}
			cursor = parent.parentUuid;
		}
	}
	return undefined;
}

function collectFieldReferences(
	field: Field,
	caseType: string,
	where: string,
	out: RetirementReference[],
): void {
	const repeatMode = field.kind === "repeat" ? field.repeat_mode : undefined;
	for (const slot of fieldReferenceSlotsFor(field.kind, repeatMode)) {
		switch (slot.kind) {
			case "case-type-ref": {
				for (const entry of readSlotStrings(field, slot.path)) {
					if (entry.text === caseType) {
						out.push({
							verbose: `field "${field.id}" in ${where} saves to it (case_property_on)`,
							concise: `field "${field.id}" in ${where} saves to it`,
						});
					}
				}
				break;
			}
			case "xpath-ast": {
				// Identity leaves name their case type directly — a leaf walk,
				// never a re-parse. Explicit multi-segment raw refs keep their
				// namespace as a type name, matching the string scan's rule.
				for (const entry of readSlotValues(field, slot.path)) {
					if (!isXPathExpression(entry.value)) continue;
					const names = xpathRefParts(entry.value).some(
						(part) =>
							(part.kind === "case-ref" && part.caseType === caseType) ||
							(part.kind === "raw-ref" &&
								part.namespace === caseType &&
								part.namespace !== "form" &&
								part.namespace !== "user" &&
								part.namespace !== "case"),
					);
					if (names) {
						out.push({
							verbose: `field "${field.id}" in ${where} references #${caseType}/… in its "${slot.slot}" expression`,
							concise: `field "${field.id}" in ${where} uses it in its ${slotLabel(slot.slot)}`,
						});
					}
				}
				break;
			}
			case "prose": {
				for (const entry of readSlotStrings(field, slot.path)) {
					if (proseNamesCaseType(entry.text, caseType)) {
						out.push({
							verbose: `field "${field.id}" in ${where} references #${caseType}/… in its "${slot.slot}" text`,
							concise: `field "${field.id}" in ${where} mentions it in its ${slotLabel(slot.slot)} text`,
						});
					}
				}
				break;
			}
			case "predicate-ast":
			case "entity-uuid":
			case "case-property-ref":
				// No field slot carries these kinds today — kept explicit so
				// the registry's kind union stays exhaustively handled here,
				// the same contract the rename rewriters hold.
				break;
			default: {
				const _exhaustive: never = slot.kind;
				break;
			}
		}
	}
}

function collectFormSlotReferences(
	form: Form,
	caseType: string,
	where: string,
	out: RetirementReference[],
): void {
	for (const operation of form.caseOperations ?? []) {
		const operationLabel = `case operation "${operation.id || operation.uuid}"`;
		if (operation.caseType === caseType) {
			out.push(sameRef(`${operationLabel} in ${where} targets "${caseType}"`));
		}
		if (operation.retype === caseType) {
			out.push(
				sameRef(`${operationLabel} in ${where} retypes to "${caseType}"`),
			);
		}
		if (
			operation.target.kind === "expression" &&
			expressionRefsCaseType(operation.target.expr, caseType)
		) {
			out.push(
				sameRef(`${operationLabel} in ${where} resolves a "${caseType}" case`),
			);
		}
		if (
			operation.condition &&
			predicateRefsCaseType(operation.condition, caseType)
		) {
			out.push(
				sameRef(
					`${operationLabel} in ${where} has a condition using "${caseType}"`,
				),
			);
		}
		for (const [label, expression] of [
			["name", operation.name],
			["owner", operation.owner],
			["rename", operation.rename],
		] as const) {
			if (expression && expressionRefsCaseType(expression, caseType)) {
				out.push(
					sameRef(
						`${operationLabel} in ${where} derives its ${label} from "${caseType}"`,
					),
				);
			}
		}
		for (const write of operation.writes ?? []) {
			if (expressionRefsCaseType(write.value, caseType)) {
				out.push(
					sameRef(
						`${operationLabel} in ${where} derives "${write.property}" from "${caseType}"`,
					),
				);
			}
			if (write.condition && predicateRefsCaseType(write.condition, caseType)) {
				out.push(
					sameRef(
						`${operationLabel} in ${where} conditionally writes "${write.property}" using "${caseType}"`,
					),
				);
			}
		}
		for (const link of operation.links ?? []) {
			if (link.targetType === caseType) {
				out.push(
					sameRef(
						`${operationLabel} in ${where} links to "${caseType}" as "${link.identifier}"`,
					),
				);
			}
			if (
				link.target?.kind === "expression" &&
				expressionRefsCaseType(link.target.expr, caseType)
			) {
				out.push(
					sameRef(
						`${operationLabel} in ${where} resolves link "${link.identifier}" from "${caseType}"`,
					),
				);
			}
		}
	}
	for (const slot of FORM_REFERENCE_SLOTS) {
		if (slot.slot === "form_display_condition") {
			if (
				form.displayCondition &&
				predicateRefsCaseType(form.displayCondition, caseType)
			) {
				out.push({
					verbose: `${where} reads a "${caseType}" property in its "${slot.slot}" condition`,
					concise: `${where} uses it in its ${slotLabel(slot.slot)}`,
				});
			}
			continue;
		}
		if (slot.kind !== "xpath-ast") continue;
		for (const entry of readSlotValues(form, slot.path)) {
			if (!isXPathExpression(entry.value)) continue;
			const names = xpathRefParts(entry.value).some(
				(part) =>
					(part.kind === "case-ref" && part.caseType === caseType) ||
					(part.kind === "raw-ref" &&
						part.namespace === caseType &&
						part.namespace !== "form" &&
						part.namespace !== "user" &&
						part.namespace !== "case"),
			);
			if (!names) continue;
			out.push({
				verbose: `${where} references #${caseType}/… in its "${slot.slot}" expression`,
				concise: `${where} uses it in its ${slotLabel(slot.slot)}`,
			});
		}
	}
}

/**
 * Self-encoded case-type references in a module's case-list + case-search
 * config: `PropertyRef` AST leaves carry their case type (origin plus
 * optional relation-walk hints), and a simple search input's `via` can
 * hint a type.
 *
 * Iterates `MODULE_REFERENCE_SLOTS` with an exhaustive switch on the slot
 * id — the same registry-driven contract the field/form scans hold — so a
 * future module slot fails this function at COMPILE time (the `never` arm)
 * until someone decides how the planner reads it, rather than silently
 * missing the retirement scan. The deliberately-skipped arms record their
 * reasons: the module's own `case_type` is OWNERSHIP, adjudicated by the
 * planner's other-owner check before this scan runs; contextual property
 * names (`columns[].field`, a simple input's `property`) follow the
 * module's current type and never name one themselves — the validator's
 * property rules adjudicate them on the same batch.
 */
function collectModuleConfigReferences(
	mod: Module,
	caseType: string,
	out: RetirementReference[],
): void {
	const where = `module "${mod.name}"`;
	const list = mod.caseListConfig;
	const search = mod.caseSearchConfig;
	const inputName = (name: string) => `search input "${name}" on ${where}`;
	const searchField = (input: { name: string; label: string }) =>
		`search field "${input.label || input.name || "Untitled field"}" on ${where}`;

	for (const slot of MODULE_REFERENCE_SLOTS) {
		switch (slot.slot) {
			case "module_display_condition": {
				if (
					mod.displayCondition &&
					predicateRefsCaseType(mod.displayCondition, caseType)
				) {
					out.push({
						verbose: `the display condition on ${where} reads a "${caseType}" property`,
						concise: `the display condition on ${where} uses "${caseType}" information`,
					});
				}
				break;
			}
			case "case_type":
				// Ownership, not a reference — `planRetirement`'s other-owner
				// check already returned `none` when another module manages
				// the type, so this slot has nothing left to say here.
				break;
			case "case_list_column_field":
			case "search_input_property":
				// Contextual property names — they follow the module's own
				// type and never name a type.
				break;
			case "case_list_column_expression": {
				for (const col of list?.columns ?? []) {
					if (
						col.kind === "calculated" &&
						expressionRefsCaseType(col.expression, caseType)
					) {
						out.push({
							verbose: `a calculated case-list column ("${col.header}") on ${where} reads a "${caseType}" property`,
							concise: `calculated information "${col.header || "Calculated value"}" in Results on ${where} uses "${caseType}" information`,
						});
					}
				}
				break;
			}
			case "case_list_filter": {
				if (list?.filter && predicateRefsCaseType(list.filter, caseType)) {
					out.push({
						verbose: `the case-list filter on ${where} reads a "${caseType}" property`,
						concise: `the Cases available setting on ${where} uses "${caseType}" information`,
					});
				}
				break;
			}
			case "search_input_via": {
				for (const input of list?.searchInputs ?? []) {
					if (
						input.kind === "simple" &&
						viaNamesCaseType(input.via, caseType)
					) {
						out.push({
							verbose: `${inputName(input.name)} walks through "${caseType}"`,
							concise: `${searchField(input)} follows a connection through the "${caseType}" case type`,
						});
					}
				}
				break;
			}
			case "search_input_default": {
				for (const input of list?.searchInputs ?? []) {
					if (
						input.default !== undefined &&
						expressionRefsCaseType(input.default, caseType)
					) {
						out.push({
							verbose: `${inputName(input.name)} defaults from a "${caseType}" property`,
							concise: `the starting value for ${searchField(input)} uses "${caseType}" information`,
						});
					}
				}
				break;
			}
			case "search_input_predicate": {
				for (const input of list?.searchInputs ?? []) {
					if (
						input.kind === "advanced" &&
						predicateRefsCaseType(input.predicate, caseType)
					) {
						out.push({
							verbose: `${inputName(input.name)} reads a "${caseType}" property`,
							concise: `the condition for ${searchField(input)} uses "${caseType}" information`,
						});
					}
				}
				break;
			}
			case "search_button_display_condition": {
				if (
					search?.searchButtonDisplayCondition &&
					predicateRefsCaseType(search.searchButtonDisplayCondition, caseType)
				) {
					out.push({
						verbose: `the search-button display condition on ${where} reads a "${caseType}" property`,
						concise: `the condition for showing the Search button on ${where} uses "${caseType}" information`,
					});
				}
				break;
			}
			case "excluded_owner_ids": {
				if (
					search?.excludedOwnerIds &&
					expressionRefsCaseType(search.excludedOwnerIds, caseType)
				) {
					out.push(
						sameRef(
							`the assigned cases setting on ${where} reads "${caseType}" information`,
						),
					);
				}
				break;
			}
			default: {
				const _exhaustive: never = slot;
				break;
			}
		}
	}
}

// ── Leaf matchers ───────────────────────────────────────────────────────

function termRefsCaseType(term: Term, caseType: string): boolean {
	if (term.kind !== "prop") return false;
	if (term.caseType === caseType) return true;
	return viaNamesCaseType(term.via, caseType);
}

function viaNamesCaseType(
	via: RelationPath | undefined,
	caseType: string,
): boolean {
	if (via === undefined || via.kind === "self") return false;
	if (via.kind === "ancestor") {
		return via.via.some((step) => step.throughCaseType === caseType);
	}
	return via.ofCaseType === caseType;
}

function predicateRefsCaseType(
	predicate: Predicate,
	caseType: string,
): boolean {
	let found = false;
	walkTerms(predicate, (term) => {
		if (termRefsCaseType(term, caseType)) found = true;
	});
	walkPredicateNodes(predicate, (node) => {
		if (
			(node.kind === "exists" || node.kind === "missing") &&
			viaNamesCaseType(node.via, caseType)
		) {
			found = true;
		}
	});
	walkPredicateExpressionNodes(predicate, (node) => {
		if (node.kind === "count" && viaNamesCaseType(node.via, caseType)) {
			found = true;
		}
	});
	return found;
}

function expressionRefsCaseType(
	expression: ValueExpression,
	caseType: string,
): boolean {
	let found = false;
	walkExpressionTerms(expression, (term) => {
		if (termRefsCaseType(term, caseType)) found = true;
	});
	walkExpressionNodes(expression, (node) => {
		if (node.kind === "count" && viaNamesCaseType(node.via, caseType)) {
			found = true;
		}
	});
	walkExpressionPredicateNodes(expression, (node) => {
		if (
			(node.kind === "exists" || node.kind === "missing") &&
			viaNamesCaseType(node.via, caseType)
		) {
			found = true;
		}
	});
	return found;
}

/** Whether prose text embeds a bare `#<caseType>/…` hashtag — located by
 *  the shared bare-hashtag matcher (prose is not XPath). */
function proseNamesCaseType(text: string, caseType: string): boolean {
	let found = false;
	transformBareHashtags(text, (hashtag) => {
		const slashIdx = hashtag.indexOf("/");
		if (slashIdx > 1 && hashtag.slice(1, slashIdx) === caseType) {
			found = true;
		}
		return hashtag;
	});
	return found;
}
