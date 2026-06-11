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
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Field, Form, Module, Uuid } from "@/lib/domain";
import {
	FORM_REFERENCE_SLOTS,
	fieldReferenceSlotsFor,
	readSlotStrings,
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

	for (const moduleUuid of doc.moduleOrder) {
		if (moduleUuid === opts.excludeModuleUuid) continue;
		const mod = doc.modules[moduleUuid];
		if (!mod) continue;
		collectModuleConfigReferences(mod, caseType, references);
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (!form) continue;
			const where = `form "${form.name}" (module "${mod.name}")`;
			collectFormSlotReferences(form, caseType, where, references);
			for (const field of fieldsUnder(doc, formUuid)) {
				collectFieldReferences(field, caseType, where, references);
			}
		}
	}

	return references;
}

/** Every field recursively under `parentUuid`, in document order. */
function* fieldsUnder(doc: BlueprintDoc, parentUuid: Uuid): Generator<Field> {
	for (const uuid of doc.fieldOrder[parentUuid] ?? []) {
		const field = doc.fields[uuid];
		if (!field) continue;
		yield field;
		yield* fieldsUnder(doc, uuid);
	}
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
 * hint a type. Contextual slots (`columns[].field`, a simple input's
 * `property`) follow the module's own type and are deliberately not
 * scanned — they never name a type.
 */
function collectModuleConfigReferences(
	mod: Module,
	caseType: string,
	out: string[],
): void {
	const where = `module "${mod.name}"`;
	const list = mod.caseListConfig;
	if (list) {
		for (const col of list.columns) {
			if (
				col.kind === "calculated" &&
				expressionRefsCaseType(col.expression, caseType)
			) {
				out.push(
					`a calculated case-list column ("${col.header}") on ${where} reads a "${caseType}" property`,
				);
			}
		}
		if (list.filter && predicateRefsCaseType(list.filter, caseType)) {
			out.push(
				`the case-list filter on ${where} reads a "${caseType}" property`,
			);
		}
		for (const input of list.searchInputs) {
			const named = `search input "${input.name}" on ${where}`;
			if (input.kind === "advanced") {
				if (predicateRefsCaseType(input.predicate, caseType)) {
					out.push(`${named} reads a "${caseType}" property`);
				}
			} else if (viaNamesCaseType(input.via, caseType)) {
				out.push(`${named} walks through "${caseType}"`);
			}
			if (
				input.default !== undefined &&
				expressionRefsCaseType(input.default, caseType)
			) {
				out.push(`${named} defaults from a "${caseType}" property`);
			}
		}
	}
	const search = mod.caseSearchConfig;
	if (search) {
		if (
			search.searchButtonDisplayCondition &&
			predicateRefsCaseType(search.searchButtonDisplayCondition, caseType)
		) {
			out.push(
				`the search-button display condition on ${where} reads a "${caseType}" property`,
			);
		}
		if (
			search.excludedOwnerIds &&
			expressionRefsCaseType(search.excludedOwnerIds, caseType)
		) {
			out.push(
				`the excluded-owners expression on ${where} reads a "${caseType}" property`,
			);
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
