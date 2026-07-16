/**
 * Rule: every `input(...)` Term reachable from a wire-emission-bound
 * predicate or value expression is either rejected outright or
 * enclosed in a `when-input-present` envelope keyed to the same
 * input name — depending on whether the slot's wire-eval context
 * has access to the user's typed search-input values.
 *
 * **Why the gate is load-bearing.** CCHQ's CSQL runtime resolves an
 * unset search-input ref to the empty string, not to absent / null
 * — so a bare `eq(prop("patient", "status"), input("status"))` emits
 * to a wire shape that matches "every case whose `status` is absent /
 * cleared / empty" when the user hasn't typed in the input, not
 * "match nothing" or "match everything." The `when-input-present`
 * envelope auto-wraps the inner predicate in CCHQ's
 * `if(count(instance(...)), <inner>, match-all)` form, which is the
 * only structural shape that preserves the authoring intent ("filter
 * only when the user has typed something") through the wire.
 *
 * The simple-arm `SearchInputDef` derives the envelope automatically
 * at wire-emit (its `(property, mode)` shape becomes
 * `when-input-present(input(name), <derived predicate>)`). Slots
 * that carry author-composed predicates / value expressions need the
 * envelope hand-authored; this rule surfaces the omission at
 * authoring time rather than letting the silent-broken semantics
 * ship to runtime.
 *
 * **Two modes per slot, set by `mode`:**
 *
 *   - `"requires-envelope"` — input refs are valid IFF wrapped in a
 *     `when-input-present` envelope keyed to the matching name. The
 *     slot's wire-eval context binds search inputs at evaluation
 *     time. Covers `caseListConfig.filter`,
 *     `caseListConfig.searchInputs[i].predicate` (advanced arm),
 *     and `caseSearchConfig.excludedOwnerIds`.
 *
 *   - `"forbids-input-ref"` — any input ref (bare or wrapped) is a
 *     structural authoring error. The slot's wire-eval context fires
 *     before the search-input layer is populated, so an input ref
 *     resolves to the empty string regardless of any envelope. The
 *     envelope is no help; the only fix is to remove the ref.
 *     Covers `caseListConfig.searchInputs[i].default`,
 *     `caseSearchConfig.searchButtonDisplayCondition`, and
 *     `caseListConfig.columns[i].expression` (calculated columns).
 *
 * **Walker contract.** The rule walks the AST top-down maintaining
 * a set of input names "currently gated by an enclosing
 * `when-input-present`." Entering a `when-input-present(input(X), …)`
 * pushes X onto the set, recurses into the clause, and pops X on
 * return. The trigger ref (`when-input-present.input`) itself is NOT
 * flagged in `"requires-envelope"` mode (it IS the gate) — but
 * `"forbids-input-ref"` mode flags every ref regardless of position,
 * including the gate. Any `input(Y)` Term that is unsafe under the
 * active mode surfaces one error per occurrence.
 *
 * Short-circuits cleanly when `caseListConfig` is absent or carries
 * no in-scope slots.
 */

import {
	type BlueprintDoc,
	caseListColumnHasRuntimeRole,
	type Module,
	type Uuid,
} from "@/lib/domain";
import type {
	Predicate,
	SearchInputRef,
	ValueExpression,
} from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";

interface BareRef {
	inputName: string;
	path: string;
}

type SlotMode = "requires-envelope" | "forbids-input-ref";

export function searchInputRefUsesWhenInputPresent(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const listConfig = mod.caseListConfig;
	const searchConfig = mod.caseSearchConfig;

	// Slot: always-on filter — input refs are valid if wrapped.
	if (listConfig?.filter !== undefined) {
		const refs = findBareInputRefs(listConfig.filter, "requires-envelope");
		for (const ref of refs) {
			errors.push(
				buildError({
					mod,
					moduleUuid,
					ref,
					mode: "requires-envelope",
					slot: "caseListConfig.filter",
					adviceSlotName: "the case list's always-on filter card",
				}),
			);
		}
	}

	// Slot: per-input authored predicates + defaults.
	for (let i = 0; i < (listConfig?.searchInputs.length ?? 0); i++) {
		const input = listConfig?.searchInputs[i];
		if (input === undefined) continue;
		const inputLabel = `search input "${input.label || input.name}" (input #${i + 1})`;

		// Advanced-arm predicate — input refs are valid if wrapped.
		if (input.kind === "advanced") {
			const refs = findBareInputRefs(input.predicate, "requires-envelope");
			for (const ref of refs) {
				errors.push(
					buildError({
						mod,
						moduleUuid,
						ref,
						mode: "requires-envelope",
						slot: `caseListConfig.searchInputs[${i}].predicate`,
						adviceSlotName: inputLabel,
					}),
				);
			}
		}

		// Default value expression — fires before any input is bound,
		// so input refs resolve to empty string regardless of envelope.
		if (input.default !== undefined) {
			const refs = findExpressionInputRefs(input.default, "forbids-input-ref");
			for (const ref of refs) {
				errors.push(
					buildError({
						mod,
						moduleUuid,
						ref,
						mode: "forbids-input-ref",
						slot: `caseListConfig.searchInputs[${i}].default`,
						adviceSlotName: `${inputLabel}'s default value`,
					}),
				);
			}
		}
	}

	// Slot: calculated columns' expression — fires per case-list row,
	// no search-input context.
	for (let i = 0; i < (listConfig?.columns.length ?? 0); i++) {
		const column = listConfig?.columns[i];
		if (
			column === undefined ||
			!caseListColumnHasRuntimeRole(column) ||
			column.kind !== "calculated"
		) {
			continue;
		}
		const refs = findExpressionInputRefs(
			column.expression,
			"forbids-input-ref",
		);
		const columnLabel = column.header || `column #${i + 1}`;
		for (const ref of refs) {
			errors.push(
				buildError({
					mod,
					moduleUuid,
					ref,
					mode: "forbids-input-ref",
					slot: `caseListConfig.columns[${i}].expression`,
					adviceSlotName: `calculated column "${columnLabel}"`,
				}),
			);
		}
	}

	// Slot: search-button display condition — fires at case-list
	// render time, no search-input context.
	if (searchConfig?.searchButtonDisplayCondition !== undefined) {
		const refs = findBareInputRefs(
			searchConfig.searchButtonDisplayCondition,
			"forbids-input-ref",
		);
		for (const ref of refs) {
			errors.push(
				buildError({
					mod,
					moduleUuid,
					ref,
					mode: "forbids-input-ref",
					slot: "caseSearchConfig.searchButtonDisplayCondition",
					adviceSlotName: "the search-button display condition",
				}),
			);
		}
	}

	// Slot: excluded owner ids — wire-emitted to `<data>` on
	// `<query>`. Wraps validly when envelope-gated; bare refs are
	// footguns. CCHQ resolves `instance('search-input:results')`
	// values at search-fire time.
	if (searchConfig?.excludedOwnerIds !== undefined) {
		const refs = findExpressionInputRefs(
			searchConfig.excludedOwnerIds,
			"requires-envelope",
		);
		for (const ref of refs) {
			errors.push(
				buildError({
					mod,
					moduleUuid,
					ref,
					mode: "requires-envelope",
					slot: "caseSearchConfig.excludedOwnerIds",
					adviceSlotName: "the excluded-owner-ids expression",
				}),
			);
		}
	}

	return errors;
}

function buildError(args: {
	mod: Module;
	moduleUuid: Uuid;
	ref: BareRef;
	mode: SlotMode;
	slot: string;
	adviceSlotName: string;
}): ValidationError {
	const { mod, moduleUuid, ref, mode, slot, adviceSlotName } = args;
	const at = ref.path ? ` (at ${ref.path})` : "";
	const message =
		mode === "requires-envelope"
			? `Module "${mod.name}" has a bare \`input("${ref.inputName}")\` reference inside ${slot}${at}. CCHQ's runtime resolves an unset input to the empty string, so the wire would match cases whose property equals "" when the user hasn't typed anything yet — not the "filter only when the input has a value" semantic the authoring shape suggests. Open ${adviceSlotName} and wrap the offending subtree in a \`when-input-present(input("${ref.inputName}"), <subtree>)\` envelope so the runtime short-circuits cleanly on an unset input; alternatively, remove the input reference if the predicate isn't supposed to depend on user input.`
			: `Module "${mod.name}" references \`input("${ref.inputName}")\` inside ${slot}${at}. The slot's wire-evaluation context fires before any search input is bound — for the default-value expression, the search screen has not yet opened; for the search-button display condition, the user is still on the case list; for a calculated column, the runtime walks each row outside any search context. The reference resolves to the empty string regardless of any \`when-input-present\` envelope, so the slot cannot react to a typed value the way the authoring shape suggests. Open ${adviceSlotName} and remove the input reference; if you need the slot to react to a search input, you likely want a different slot (e.g. \`caseListConfig.filter\` for filtering, or an advanced-arm search-input predicate for input-driven matching).`;
	return validationError(
		"CASE_LIST_BARE_SEARCH_INPUT_REF",
		"module",
		message,
		{ moduleUuid, moduleName: mod.name },
		{ inputName: ref.inputName, slot, path: ref.path, mode },
	);
}

/**
 * Walk a Predicate AST and surface every input Term that violates
 * the slot's `mode`. In `"requires-envelope"` mode the walker tracks
 * which input names are gated by an enclosing `when-input-present`;
 * in `"forbids-input-ref"` mode the walker flags every input ref
 * regardless of envelope.
 */
function findBareInputRefs(predicate: Predicate, mode: SlotMode): BareRef[] {
	const refs: BareRef[] = [];
	const gated = new Set<string>();
	visitPredicate(predicate, "", gated, mode, refs);
	return refs;
}

/**
 * Same walk for a ValueExpression root. Used for slots whose schema
 * holds a `ValueExpression` (`searchInputs[i].default`,
 * `caseSearchConfig.excludedOwnerIds`, calculated-column
 * `expression`).
 */
function findExpressionInputRefs(
	expression: ValueExpression,
	mode: SlotMode,
): BareRef[] {
	const refs: BareRef[] = [];
	const gated = new Set<string>();
	visitExpression(expression, "", gated, mode, refs);
	return refs;
}

function visitPredicate(
	predicate: Predicate,
	path: string,
	gated: Set<string>,
	mode: SlotMode,
	out: BareRef[],
): void {
	switch (predicate.kind) {
		case "match-all":
		case "match-none":
			return;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			visitExpression(predicate.left, joinPath(path, "left"), gated, mode, out);
			visitExpression(
				predicate.right,
				joinPath(path, "right"),
				gated,
				mode,
				out,
			);
			return;
		case "in":
			visitExpression(predicate.left, joinPath(path, "left"), gated, mode, out);
			// `in.values` are Literals — they cannot syntactically carry
			// an input ref. No recursion needed.
			return;
		case "within-distance":
			// `property` is a `PropertyRef` (not an input ref).
			visitExpression(
				predicate.center,
				joinPath(path, "center"),
				gated,
				mode,
				out,
			);
			return;
		case "match":
			// `match.value` is a `ValueExpression` (per `matchSchema`),
			// not a bare literal — the type checker admits term-arm
			// shapes including `term(input(...))` so the validator must
			// walk the value to surface every reachable input ref.
			visitExpression(
				predicate.value,
				joinPath(path, "value"),
				gated,
				mode,
				out,
			);
			return;
		case "multi-select-contains":
			// `property` is a `PropertyRef`; `values` is `[Literal, ...]`.
			// No input refs reachable.
			return;
		case "is-null":
		case "is-blank":
			visitExpression(predicate.left, joinPath(path, "left"), gated, mode, out);
			return;
		case "between":
			visitExpression(predicate.left, joinPath(path, "left"), gated, mode, out);
			if (predicate.lower !== undefined) {
				visitExpression(
					predicate.lower,
					joinPath(path, "lower"),
					gated,
					mode,
					out,
				);
			}
			if (predicate.upper !== undefined) {
				visitExpression(
					predicate.upper,
					joinPath(path, "upper"),
					gated,
					mode,
					out,
				);
			}
			return;
		case "and":
		case "or":
			for (let i = 0; i < predicate.clauses.length; i++) {
				visitPredicate(
					predicate.clauses[i],
					joinPath(path, `${predicate.kind}.${i}`),
					gated,
					mode,
					out,
				);
			}
			return;
		case "not":
			visitPredicate(predicate.clause, joinPath(path, "not"), gated, mode, out);
			return;
		case "when-input-present": {
			// In `requires-envelope` mode the trigger ref is the gate
			// (never flagged) and the clause walks under the widened
			// gating set. In `forbids-input-ref` mode the trigger ref is
			// still an input reference in a no-input-context slot — flag
			// it as well, and the gating set does nothing for the clause.
			const triggerName = predicate.input.name;
			if (mode === "forbids-input-ref") {
				out.push({ inputName: triggerName, path: joinPath(path, "input") });
				visitPredicate(
					predicate.clause,
					joinPath(path, "clause"),
					gated,
					mode,
					out,
				);
				return;
			}
			const wasAlreadyGated = gated.has(triggerName);
			gated.add(triggerName);
			visitPredicate(
				predicate.clause,
				joinPath(path, "when-input-present.clause"),
				gated,
				mode,
				out,
			);
			if (!wasAlreadyGated) gated.delete(triggerName);
			return;
		}
		case "exists":
		case "missing":
			if (predicate.where !== undefined) {
				visitPredicate(
					predicate.where,
					joinPath(path, `${predicate.kind}.where`),
					gated,
					mode,
					out,
				);
			}
			return;
		default: {
			const _exhaustive: never = predicate;
			throw new Error(
				`searchInputRefUsesWhenInputPresent: unhandled predicate kind ${String(
					_exhaustive,
				)}`,
			);
		}
	}
}

function visitExpression(
	expr: ValueExpression,
	path: string,
	gated: Set<string>,
	mode: SlotMode,
	out: BareRef[],
): void {
	switch (expr.kind) {
		case "term":
			if (expr.term.kind === "input") {
				visitInputRef(expr.term, path, gated, mode, out);
			}
			return;
		case "today":
		case "now":
			return;
		case "date-add":
			visitExpression(expr.date, joinPath(path, "date"), gated, mode, out);
			visitExpression(
				expr.quantity,
				joinPath(path, "quantity"),
				gated,
				mode,
				out,
			);
			return;
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list":
			visitExpression(expr.value, joinPath(path, "value"), gated, mode, out);
			return;
		case "format-date":
			visitExpression(expr.date, joinPath(path, "date"), gated, mode, out);
			return;
		case "arith":
			visitExpression(expr.left, joinPath(path, "left"), gated, mode, out);
			visitExpression(expr.right, joinPath(path, "right"), gated, mode, out);
			return;
		case "concat":
			for (let i = 0; i < expr.parts.length; i++) {
				visitExpression(
					expr.parts[i],
					joinPath(path, `concat.${i}`),
					gated,
					mode,
					out,
				);
			}
			return;
		case "coalesce":
			for (let i = 0; i < expr.values.length; i++) {
				visitExpression(
					expr.values[i],
					joinPath(path, `coalesce.${i}`),
					gated,
					mode,
					out,
				);
			}
			return;
		case "if":
			visitPredicate(expr.cond, joinPath(path, "if.cond"), gated, mode, out);
			visitExpression(expr.then, joinPath(path, "if.then"), gated, mode, out);
			visitExpression(expr.else, joinPath(path, "if.else"), gated, mode, out);
			return;
		case "switch":
			visitExpression(expr.on, joinPath(path, "switch.on"), gated, mode, out);
			for (let i = 0; i < expr.cases.length; i++) {
				visitExpression(
					expr.cases[i].then,
					joinPath(path, `switch.cases.${i}.then`),
					gated,
					mode,
					out,
				);
			}
			visitExpression(
				expr.fallback,
				joinPath(path, "switch.fallback"),
				gated,
				mode,
				out,
			);
			return;
		case "count":
			if (expr.where !== undefined) {
				visitPredicate(
					expr.where,
					joinPath(path, "count.where"),
					gated,
					mode,
					out,
				);
			}
			return;
		default: {
			const _exhaustive: never = expr;
			throw new Error(
				`searchInputRefUsesWhenInputPresent: unhandled value expression kind ${String(
					_exhaustive,
				)}`,
			);
		}
	}
}

function visitInputRef(
	ref: SearchInputRef,
	path: string,
	gated: Set<string>,
	mode: SlotMode,
	out: BareRef[],
): void {
	if (mode === "requires-envelope" && gated.has(ref.name)) return;
	out.push({ inputName: ref.name, path });
}

function joinPath(parent: string, segment: string): string {
	return parent === "" ? segment : `${parent}.${segment}`;
}
