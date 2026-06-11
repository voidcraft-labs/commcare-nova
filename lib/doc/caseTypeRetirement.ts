/**
 * Orphaned case-type-record retirement — what keeps "stop tracking this
 * case type" satisfiable under the single commit rule.
 *
 * A case-type record can only LAND with the module that satisfies its
 * validator obligations (`createModule`'s atomic shape), so removing
 * that module — or retyping it via a module case-type change — leaves
 * the record with no owning module. For a CHILD record that state IS a
 * finding (`MISSING_CHILD_CASE_MODULE`), and a batch that introduces it
 * would be rejected with guidance opposite to the user's intent ("add a
 * module with case_type X" when the user is deleting X). The cascade
 * here resolves that: when the displaced type's record would be left
 * module-less AND nothing else in the doc references the type, the same
 * batch retires the record (`setCaseTypes` minus that entry); when
 * references remain, the planner reports them so the rejection names a
 * repair the user can actually perform.
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

import { parser } from "@/lib/commcare/xpath";
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
	walkExpressionTerms,
	walkTerms,
} from "@/lib/domain/predicate";
import { transformBareHashtags } from "@/lib/preview/engine/labelRefs";

// ── Outcome shape ───────────────────────────────────────────────────────

/** The cascade decision for a batch that displaces a module's case type. */
export type CaseTypeRetirement =
	/** No record is being orphaned — the batch needs no cascade. */
	| { kind: "none" }
	/** The displaced type's record is orphaned and unreferenced — append
	 *  `mutations` to the same batch to retire it. */
	| { kind: "retire"; caseType: string; mutations: Mutation[] }
	/** The displaced type's record is orphaned but still referenced —
	 *  the batch must not run; `message` names every reference and the
	 *  repair. */
	| {
			kind: "blocked";
			caseType: string;
			references: string[];
			message: string;
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
			references,
			message: blockedRetirementMessage(opts.action, displaced, references),
		};
	}

	const remaining = (doc.caseTypes ?? []).filter((ct) => ct.name !== displaced);
	return {
		kind: "retire",
		caseType: displaced,
		mutations: [
			{
				kind: "setCaseTypes",
				// An emptied catalog stores as `null`, the same shape a fresh
				// app is born with — `[]` and `null` read identically but the
				// doc keeps one canonical spelling.
				caseTypes: remaining.length > 0 ? remaining : null,
			},
		],
	};
}

/** One person-to-person rejection both the tool envelope and the builder
 *  toast carry — what was tried, why it can't run, and the repair. */
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
export function findCaseTypeReferences(
	doc: BlueprintDoc,
	caseType: string,
	opts: { excludeModuleUuid?: Uuid } = {},
): string[] {
	const references: string[] = [];

	for (const ct of doc.caseTypes ?? []) {
		if (ct.name !== caseType && ct.parent_type === caseType) {
			references.push(
				`case type "${ct.name}" declares "${caseType}" as its parent`,
			);
		}
	}

	/* The blocked-verdict list reads in document order (modules in
	 * `moduleOrder`, a module's own config before its forms, forms in
	 * order, fields depth-first), so the looked-up carriers are placed
	 * and sorted before their descriptions render. A carrier that can't
	 * be placed (not reachable through the order arrays) is skipped —
	 * the walk this lookup replaced never visited those either. */
	const placed: CarrierPlacement[] = [];
	for (const carrierUuid of referencingCarrierUuids(
		doc,
		caseTypeTargetKey(caseType),
	)) {
		const placement = placeCarrier(doc, carrierUuid as Uuid);
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

function placeCarrier(
	doc: BlueprintDoc,
	uuid: Uuid,
): CarrierPlacement | undefined {
	if (doc.modules[uuid]) {
		const moduleIndex = doc.moduleOrder.indexOf(uuid);
		if (moduleIndex === -1) return undefined;
		return { uuid, moduleUuid: uuid, rank: [moduleIndex, -1] };
	}
	if (doc.forms[uuid]) {
		const position = formPosition(doc, uuid);
		if (!position) return undefined;
		return {
			uuid,
			moduleUuid: position.moduleUuid,
			rank: [position.moduleIndex, position.formIndex, -1],
		};
	}
	if (doc.fields[uuid]) {
		// Climb to the containing form collecting each level's sibling
		// index — the depth-first rank within the form.
		const childIndices: number[] = [];
		let cursor: Uuid = uuid;
		const seen = new Set<Uuid>();
		while (!seen.has(cursor)) {
			seen.add(cursor);
			const parent = findFieldParent(doc, cursor);
			if (!parent) return undefined;
			childIndices.unshift(parent.index);
			if (doc.forms[parent.parentUuid]) {
				const position = formPosition(doc, parent.parentUuid);
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

function formPosition(
	doc: BlueprintDoc,
	formUuid: Uuid,
): { moduleUuid: Uuid; moduleIndex: number; formIndex: number } | undefined {
	for (const [moduleIndex, moduleUuid] of doc.moduleOrder.entries()) {
		const formIndex = (doc.formOrder[moduleUuid] ?? []).indexOf(formUuid);
		if (formIndex !== -1) return { moduleUuid, moduleIndex, formIndex };
	}
	return undefined;
}

function collectFieldReferences(
	field: Field,
	caseType: string,
	where: string,
	out: string[],
): void {
	const repeatMode = field.kind === "repeat" ? field.repeat_mode : undefined;
	for (const slot of fieldReferenceSlotsFor(field.kind, repeatMode)) {
		switch (slot.kind) {
			case "case-type-ref": {
				for (const entry of readSlotStrings(field, slot.path)) {
					if (entry.text === caseType) {
						out.push(
							`field "${field.id}" in ${where} saves to it (case_property_on)`,
						);
					}
				}
				break;
			}
			case "xpath": {
				for (const entry of readSlotStrings(field, slot.path)) {
					if (expressionNamesCaseType(entry.text, caseType)) {
						out.push(
							`field "${field.id}" in ${where} references #${caseType}/… in its "${slot.slot}" expression`,
						);
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
						out.push(
							`field "${field.id}" in ${where} references #${caseType}/… in its "${slot.slot}" expression`,
						);
					}
				}
				break;
			}
			case "prose": {
				for (const entry of readSlotStrings(field, slot.path)) {
					if (proseNamesCaseType(entry.text, caseType)) {
						out.push(
							`field "${field.id}" in ${where} references #${caseType}/… in its "${slot.slot}" text`,
						);
					}
				}
				break;
			}
			case "predicate-ast":
			case "field-id-ref":
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
	out: string[],
): void {
	for (const slot of FORM_REFERENCE_SLOTS) {
		if (slot.kind !== "xpath") continue;
		for (const entry of readSlotStrings(form, slot.path)) {
			if (expressionNamesCaseType(entry.text, caseType)) {
				out.push(
					`${where} references #${caseType}/… in its "${slot.slot}" expression`,
				);
			}
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
	out: string[],
): void {
	const where = `module "${mod.name}"`;
	const list = mod.caseListConfig;
	const search = mod.caseSearchConfig;
	const inputName = (name: string) => `search input "${name}" on ${where}`;

	for (const slot of MODULE_REFERENCE_SLOTS) {
		switch (slot.slot) {
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
						out.push(
							`a calculated case-list column ("${col.header}") on ${where} reads a "${caseType}" property`,
						);
					}
				}
				break;
			}
			case "case_list_filter": {
				if (list?.filter && predicateRefsCaseType(list.filter, caseType)) {
					out.push(
						`the case-list filter on ${where} reads a "${caseType}" property`,
					);
				}
				break;
			}
			case "search_input_via": {
				for (const input of list?.searchInputs ?? []) {
					if (
						input.kind === "simple" &&
						viaNamesCaseType(input.via, caseType)
					) {
						out.push(`${inputName(input.name)} walks through "${caseType}"`);
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
						out.push(
							`${inputName(input.name)} defaults from a "${caseType}" property`,
						);
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
						out.push(`${inputName(input.name)} reads a "${caseType}" property`);
					}
				}
				break;
			}
			case "search_button_display_condition": {
				if (
					search?.searchButtonDisplayCondition &&
					predicateRefsCaseType(search.searchButtonDisplayCondition, caseType)
				) {
					out.push(
						`the search-button display condition on ${where} reads a "${caseType}" property`,
					);
				}
				break;
			}
			case "excluded_owner_ids": {
				if (
					search?.excludedOwnerIds &&
					expressionRefsCaseType(search.excludedOwnerIds, caseType)
				) {
					out.push(
						`the excluded-owners expression on ${where} reads a "${caseType}" property`,
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
	return found;
}

/** Pre-resolved Lezer node type for `#…/…` references. */
const HASHTAG_REF_TYPES = new Set(
	parser.nodeSet.types.filter((t) => t.name === "HashtagRef"),
);

/**
 * Whether an XPath expression carries a `#<caseType>/…` hashtag. Read
 * through the Lezer grammar — a hashtag is a structural node, never a
 * substring pattern.
 */
function expressionNamesCaseType(expr: string, caseType: string): boolean {
	if (!expr.includes("#")) return false;
	const tree = parser.parse(expr);
	let found = false;
	tree.iterate({
		enter(node) {
			if (found || !HASHTAG_REF_TYPES.has(node.type)) return;
			const text = expr.slice(node.from, node.to);
			const slashIdx = text.indexOf("/");
			if (slashIdx > 1 && text.slice(1, slashIdx) === caseType) {
				found = true;
			}
		},
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
