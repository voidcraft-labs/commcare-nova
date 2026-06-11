// lib/doc/expressionMigration.ts
//
// One-time conversion of stored expression slots from their legacy
// string form to the expression AST — the shared core the scan/migrate
// scripts and the byte-identity proofs drive. Steady-state code never
// calls this: live commits parse at their own boundaries
// (`expressionText.ts`), and the codebase reads only the new shape.
//
// The conversion is ROUND-TRIP-GATED per slot: a string converts only
// when printing its parsed AST against the same doc reproduces the
// original bytes exactly. The parser/printer pair holds that law for
// every input by construction (fuzz-pinned), so a failure here means
// the pair has a bug — the slot is REPORTED and left as its original
// string (which every reader still projects verbatim), never silently
// "fixed".
//
// Registry-driven: the slot list is the reference-slot registry's
// `xpath-ast` projection, so each surface that migrates to the AST
// representation joins this converter by flipping its registry kind —
// no second slot list to maintain.

import { parseXPathExpression } from "@/lib/commcare/xpath";
import { resolveCloseFieldRef } from "@/lib/doc/expressionText";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import {
	FIELD_REFERENCE_SLOTS,
	FORM_REFERENCE_SLOTS,
	fieldPathResolver,
	printXPath,
	type ReferenceSlot,
	type ResolveFieldPath,
	rewriteSlotValues,
	xpathPrintContext,
} from "@/lib/domain";

/** A close condition whose field reference no id in its form answers
 *  to — left verbatim (the validator's close-condition rules carry the
 *  signal), reported so the scan can size the class. */
export interface UnresolvedCloseFieldRef {
	formUuid: string;
	ref: string;
}

/** One slot whose stored text did not survive the round-trip law. */
export interface ExpressionConversionFailure {
	/** Owning entity's uuid (field or form). */
	entityUuid: string;
	/** Registry slot id (`calculate`, `relevant`, …). */
	slot: string;
	/** The stored text, verbatim. */
	text: string;
	/** What printing the parsed AST produced instead. */
	printed: string;
}

export interface DocExpressionMigrationResult {
	/** Slots converted string → AST. */
	converted: number;
	/** Slots already in (or compatible with) the new shape — skipped. */
	skipped: number;
	/** Round-trip failures — reported, left as strings. */
	failures: ExpressionConversionFailure[];
	/** Close-condition refs converted id → uuid. */
	closeRefsConverted: number;
	/** Close-condition refs nothing answered to — left verbatim. */
	unresolvedCloseRefs: UnresolvedCloseFieldRef[];
}

const FIELD_AST_SLOTS = FIELD_REFERENCE_SLOTS.filter(
	(slot) => slot.kind === "xpath-ast",
);
// Typed over the WIDE slot shape: the form registry carries no
// `xpath-ast` entries until its surfaces migrate, and the literal-tuple
// narrowing would otherwise collapse this filter's element type.
const FORM_AST_SLOTS = (
	FORM_REFERENCE_SLOTS as readonly ReferenceSlot[]
).filter((slot) => slot.kind === "xpath-ast");

/**
 * Convert every legacy string under an AST-slot path on `doc`, in
 * place. The doc is the RAW persisted record (its expression slots may
 * be strings, ASTs, or absent); applicability is deliberately not
 * consulted — a value parked on an off-kind slot by a lenient path
 * converts too, so the canonical shape is total over what is actually
 * stored.
 */
export function migrateDocExpressions(
	doc: BlueprintDoc,
): DocExpressionMigrationResult {
	const result: DocExpressionMigrationResult = {
		converted: 0,
		skipped: 0,
		failures: [],
		closeRefsConverted: 0,
		unresolvedCloseRefs: [],
	};
	const printCtx = () => xpathPrintContext(doc);

	const convert = (
		entityUuid: string,
		slotId: string,
		resolve: ResolveFieldPath,
		value: unknown,
	): unknown => {
		if (typeof value !== "string") {
			result.skipped++;
			return value;
		}
		const expr = parseXPathExpression(value, resolve);
		const printed = printXPath(expr, printCtx());
		if (printed !== value) {
			result.failures.push({ entityUuid, slot: slotId, text: value, printed });
			return value;
		}
		result.converted++;
		return expr;
	};

	// Fields resolve against their containing form; fields reachable
	// from no form (orphans in degenerate docs) resolve nothing — their
	// references stay raw leaves, the dangling treatment.
	const formOfField = new Map<string, Uuid>();
	for (const formUuid of Object.keys(doc.forms)) {
		const stack = [...(doc.fieldOrder[formUuid] ?? [])];
		while (stack.length > 0) {
			const uuid = stack.pop();
			if (uuid === undefined) continue;
			formOfField.set(uuid, formUuid as Uuid);
			for (const child of doc.fieldOrder[uuid] ?? []) stack.push(child);
		}
	}

	for (const [uuid, field] of Object.entries(doc.fields)) {
		if (!field) continue;
		const resolve = fieldPathResolver(doc, formOfField.get(uuid));
		for (const slot of FIELD_AST_SLOTS) {
			rewriteSlotValues(field, slot.path, (value) =>
				convert(uuid, slot.slot, resolve, value),
			);
		}
	}

	for (const [uuid, form] of Object.entries(doc.forms)) {
		if (!form) continue;
		const resolve = fieldPathResolver(doc, uuid);
		for (const slot of FORM_AST_SLOTS) {
			rewriteSlotValues(form, slot.path, (value) =>
				convert(uuid, slot.slot, resolve, value),
			);
		}
		migrateCloseCondition(doc, uuid, form, result);
	}

	return result;
}

/**
 * Convert a legacy close-condition field reference (a bare leaf id) to
 * the target field's stable uuid — pre-order first match, the exact
 * field the id-stored era's wire emission resolved to, so the emitted
 * bytes cannot move. A ref already naming a field uuid is current; a
 * ref nothing answers to stays verbatim and is reported.
 */
function migrateCloseCondition(
	doc: BlueprintDoc,
	formUuid: string,
	form: unknown,
	result: DocExpressionMigrationResult,
): void {
	const closeCondition = (form as { closeCondition?: { field?: unknown } })
		.closeCondition;
	const ref = closeCondition?.field;
	if (typeof ref !== "string" || ref.length === 0) return;
	if (doc.fields[ref as Uuid] !== undefined) {
		result.skipped++;
		return;
	}
	const resolved = resolveCloseFieldRef(doc, formUuid, ref);
	if (resolved === ref) {
		result.unresolvedCloseRefs.push({ formUuid, ref });
		return;
	}
	(closeCondition as { field: string }).field = resolved;
	result.closeRefsConverted++;
}
