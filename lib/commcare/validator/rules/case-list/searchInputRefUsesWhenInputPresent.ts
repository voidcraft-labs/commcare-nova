/**
 * Rule: every `input(...)` Term reachable from a wire-emission-bound
 * predicate is enclosed in a `when-input-present` envelope keyed to
 * the same input name.
 *
 * **Why the envelope is load-bearing.** CCHQ's CSQL runtime resolves
 * an unset search-input ref to the empty string, not to absent / null
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
 * `when-input-present(input(name), <derived predicate>)`). The
 * advanced arm receives the author's predicate verbatim, so the
 * author must add the envelope themselves; this rule surfaces the
 * omission at authoring time rather than letting the silent-broken
 * semantics ship to runtime.
 *
 * **Wire-emission-bound slots covered.** Two predicate slots flow to
 * the CSQL wire:
 *
 *   - `caseListConfig.filter` — the always-on filter, AND-composed
 *     into `<data key="_xpath_query">` at every CSQL emission.
 *   - `caseListConfig.searchInputs[i].predicate` (advanced arm) —
 *     each advanced-arm predicate AND-composes into the same
 *     `_xpath_query` block. The simple arm carries no authored
 *     predicate slot, so it short-circuits without inspection.
 *
 * `caseSearchConfig.searchButtonDisplayCondition` is NOT covered —
 * the predicate gates the search-button render BEFORE any input has
 * been populated, so input refs inside it are structurally
 * meaningless. The predicate type checker's `knownInputs`-scoped
 * orphan resolution catches references to non-declared input names
 * elsewhere.
 *
 * **Walker contract.** The rule walks the AST top-down maintaining
 * a set of input names "currently gated by an enclosing
 * `when-input-present`." Entering a `when-input-present(input(X), …)`
 * pushes X onto the set, recurses into the clause, and pops X on
 * return. The trigger ref (`when-input-present.input`) itself is NOT
 * flagged — it is the gate, not a bare consumer. Any other
 * `input(Y)` Term encountered with Y not in the gating set surfaces
 * one error per occurrence.
 *
 * Short-circuits cleanly when `caseListConfig` is absent or carries
 * no in-scope predicate slots.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
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

export function searchInputRefUsesWhenInputPresent(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const config = mod.caseListConfig;
	if (!config) return [];

	const errors: ValidationError[] = [];

	// Slot 1: the always-on filter. Bare input refs here AND-compose
	// into the wire alongside the search-input bindings, so the silent-
	// break applies the same way as the advanced-arm predicates do.
	if (config.filter !== undefined) {
		const bareRefs = findBareInputRefs(config.filter);
		for (const ref of bareRefs) {
			errors.push(
				buildError({
					mod,
					moduleUuid,
					inputName: ref.inputName,
					path: ref.path,
					slot: "caseListConfig.filter",
					adviceSlotName: "the case list's always-on filter card",
				}),
			);
		}
	}

	// Slot 2: every advanced-arm search input's authored predicate.
	for (let i = 0; i < config.searchInputs.length; i++) {
		const input = config.searchInputs[i];
		if (input.kind !== "advanced") continue;
		const bareRefs = findBareInputRefs(input.predicate);
		for (const ref of bareRefs) {
			errors.push(
				buildError({
					mod,
					moduleUuid,
					inputName: ref.inputName,
					path: ref.path,
					slot: `caseListConfig.searchInputs[${i}].predicate`,
					adviceSlotName: `search input "${input.label || input.name}" (input #${i + 1})`,
				}),
			);
		}
	}

	return errors;
}

function buildError(args: {
	mod: Module;
	moduleUuid: Uuid;
	inputName: string;
	path: string;
	slot: string;
	adviceSlotName: string;
}): ValidationError {
	const { mod, moduleUuid, inputName, path, slot, adviceSlotName } = args;
	const at = path ? ` (at ${path})` : "";
	return validationError(
		"CASE_LIST_BARE_SEARCH_INPUT_REF",
		"module",
		`Module "${mod.name}" has a bare \`input("${inputName}")\` reference inside ${slot}${at}. CCHQ's runtime resolves an unset input to the empty string, so the wire would match cases whose property equals "" when the user hasn't typed anything yet — not the "filter only when the input has a value" semantic the authoring shape suggests. Open ${adviceSlotName} and wrap the offending subtree in a \`when-input-present(input("${inputName}"), <subtree>)\` envelope so the runtime short-circuits cleanly on an unset input; alternatively, remove the input reference if the predicate isn't supposed to depend on user input.`,
		{ moduleUuid, moduleName: mod.name },
		{ inputName, slot, path },
	);
}

/**
 * Walk the predicate AST top-down, tracking which input names are
 * currently gated by an enclosing `when-input-present`. Emits one
 * `BareRef` per offending input Term — the gating set narrows
 * per-`when-input-present` clause and widens back on return so
 * siblings outside the envelope still surface.
 */
function findBareInputRefs(predicate: Predicate): BareRef[] {
	const refs: BareRef[] = [];
	const gated = new Set<string>();
	visitPredicate(predicate, "", gated, refs);
	return refs;
}

function visitPredicate(
	predicate: Predicate,
	path: string,
	gated: Set<string>,
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
			visitExpression(predicate.left, joinPath(path, "left"), gated, out);
			visitExpression(predicate.right, joinPath(path, "right"), gated, out);
			return;
		case "in":
			visitExpression(predicate.left, joinPath(path, "left"), gated, out);
			// `in.values` are Literals — they cannot syntactically carry
			// an input ref. No recursion needed.
			return;
		case "within-distance":
			// `property` is a `PropertyRef` (not an input ref).
			visitExpression(predicate.center, joinPath(path, "center"), gated, out);
			return;
		case "match":
		case "multi-select-contains":
			// `property` is a `PropertyRef`; `value`/`values` are
			// Literal(s). No input refs reachable.
			return;
		case "is-null":
		case "is-blank":
			visitExpression(predicate.left, joinPath(path, "left"), gated, out);
			return;
		case "between":
			visitExpression(predicate.left, joinPath(path, "left"), gated, out);
			if (predicate.lower !== undefined) {
				visitExpression(predicate.lower, joinPath(path, "lower"), gated, out);
			}
			if (predicate.upper !== undefined) {
				visitExpression(predicate.upper, joinPath(path, "upper"), gated, out);
			}
			return;
		case "and":
		case "or":
			for (let i = 0; i < predicate.clauses.length; i++) {
				visitPredicate(
					predicate.clauses[i],
					joinPath(path, `${predicate.kind}.${i}`),
					gated,
					out,
				);
			}
			return;
		case "not":
			visitPredicate(predicate.clause, joinPath(path, "not"), gated, out);
			return;
		case "when-input-present": {
			// The trigger ref itself is structurally the gate, not a
			// "bare ref" — never report it. Widen the gating set for the
			// clause walk only.
			const triggerName = predicate.input.name;
			const wasAlreadyGated = gated.has(triggerName);
			gated.add(triggerName);
			visitPredicate(
				predicate.clause,
				joinPath(path, "when-input-present.clause"),
				gated,
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
	out: BareRef[],
): void {
	switch (expr.kind) {
		case "term":
			if (expr.term.kind === "input") {
				visitInputRef(expr.term, path, gated, out);
			}
			return;
		case "today":
		case "now":
			return;
		case "date-add":
			visitExpression(expr.date, joinPath(path, "date"), gated, out);
			visitExpression(expr.quantity, joinPath(path, "quantity"), gated, out);
			return;
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list":
			visitExpression(expr.value, joinPath(path, "value"), gated, out);
			return;
		case "format-date":
			visitExpression(expr.date, joinPath(path, "date"), gated, out);
			return;
		case "arith":
			visitExpression(expr.left, joinPath(path, "left"), gated, out);
			visitExpression(expr.right, joinPath(path, "right"), gated, out);
			return;
		case "concat":
			for (let i = 0; i < expr.parts.length; i++) {
				visitExpression(
					expr.parts[i],
					joinPath(path, `concat.${i}`),
					gated,
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
					out,
				);
			}
			return;
		case "if":
			visitPredicate(expr.cond, joinPath(path, "if.cond"), gated, out);
			visitExpression(expr.then, joinPath(path, "if.then"), gated, out);
			visitExpression(expr.else, joinPath(path, "if.else"), gated, out);
			return;
		case "switch":
			visitExpression(expr.on, joinPath(path, "switch.on"), gated, out);
			for (let i = 0; i < expr.cases.length; i++) {
				visitExpression(
					expr.cases[i].then,
					joinPath(path, `switch.cases.${i}.then`),
					gated,
					out,
				);
			}
			visitExpression(
				expr.fallback,
				joinPath(path, "switch.fallback"),
				gated,
				out,
			);
			return;
		case "count":
			if (expr.where !== undefined) {
				visitPredicate(expr.where, joinPath(path, "count.where"), gated, out);
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
	out: BareRef[],
): void {
	if (gated.has(ref.name)) return;
	out.push({ inputName: ref.name, path });
}

function joinPath(parent: string, segment: string): string {
	return parent === "" ? segment : `${parent}.${segment}`;
}
