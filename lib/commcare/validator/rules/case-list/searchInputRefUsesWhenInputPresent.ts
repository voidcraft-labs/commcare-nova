/**
 * Rule: every `input(...)` Term reachable from a wire-emission-bound
 * predicate or value expression is either rejected outright or enclosed in a
 * `when-input-present` envelope keyed to the same input name — depending on
 * whether the slot's wire-eval context has access to the user's typed
 * search-input values. The assigned-case exclusion is the one value-slot
 * exception: blank means "exclude nobody" there, so a direct Search answer is
 * safe and useful.
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
 *     time. Covers `caseListConfig.filter` and
 *     `caseListConfig.searchInputs[i].predicate` (advanced arm).
 *
 *   - `"forbids-input-ref"` — any input ref (bare or wrapped) is a
 *     structural authoring error, for one of two reasons the envelope
 *     can't fix. A prompt DEFAULT evaluates before the user has typed,
 *     so the ref reads an unanswered instance and resolves to the
 *     empty string. The search-button display condition and a
 *     calculated column evaluate on the ordinary case list, where the
 *     `search-input` instance is not loaded at all — commcare-core
 *     throws on the first touch of a declared-but-unloaded instance
 *     (`XPathPathExpr.evalRaw`), before any enclosing guard runs, so
 *     the ref would error the whole screen. Either way the only fix
 *     is to remove the ref. Covers
 *     `caseListConfig.searchInputs[i].default`,
 *     `caseListConfig.searchInputs[i].value` (a hidden input's value,
 *     which re-evaluates at every query-screen construction before
 *     answers exist — `QueryScreen.init`),
 *     `caseSearchConfig.searchButtonDisplayCondition`, and
 *     `caseListConfig.columns[i].expression` (calculated columns).
 *
 * **Two slots are in neither mode on purpose.** A visible input's
 * `required.when` and `validation.rule` evaluate ON the Search screen with
 * the search-input instance loaded
 * (`RemoteQuerySessionManager.validateUserAnswers` builds the evaluation
 * context over `search-input:<storage>`), so a bare `input(...)` of any
 * sibling is exactly right there: an unanswered sibling reads blank and
 * `is-blank(input(...))` is the honest "not answered" test. Requiring the
 * envelope would refuse the one place it is not needed. A choice input's
 * `options.filter` is refused any input ref by
 * `searchInputScreenPredicateTypeCheck` (its choices are built before
 * anyone answers), with that rule's own repair.
 *
 * `caseSearchConfig.excludedOwnerIds` is intentionally in neither mode. The
 * expression resolves at Search fire time and blank is its identity value:
 * Preview parses it as an empty exclusion list, remote Search receives no ids,
 * and the ordinary-list nodeset explicitly short-circuits on
 * `normalize-space(value) = ''`. Requiring a predicate envelope around a value
 * branch cannot express that contract and would reject every useful
 * `input(...)` return value.
 *
 * **A read the device makes before the search runs needs no gate.** In a
 * slot CommCare's search reads (the filter while Search is on, and an
 * advanced input's condition), a condition that chooses between clauses and
 * a clause that reads no case row are `runtime` subtrees in `query`
 * position (`lib/domain/expression/csqlPositions.ts`): Core evaluates them
 * on the device, where an unanswered input reads `''`, a defined value, and
 * HQ never sees the input at all (part 06 §3.10). So the envelope is
 * required only of an input whose value is interpolated into the query.
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
	effectiveCaseSearchConfig,
	isOwnerOnlyCaseSearchConfig,
	type Module,
	searchInputDefault,
	type Uuid,
} from "@/lib/domain";
import {
	type CheckPath,
	type Expression,
	expressionChildren,
	type Term,
} from "@/lib/domain/expression";
import { csqlRuntimeRoots } from "@/lib/domain/expression/csqlPositions";
import { type ValidationError, validationError } from "../../errors";

interface BareRef {
	inputUuid: Uuid;
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
		const refs = findBareInputRefs(
			listConfig.filter,
			"requires-envelope",
			effectiveCaseSearchConfig(mod) !== undefined,
		);
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
			const refs = findBareInputRefs(
				input.predicate,
				"requires-envelope",
				true,
			);
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

		// A hidden input's value — re-evaluated at every query-screen
		// construction, before any answer exists, so an input ref reads
		// blank whatever envelope surrounds it.
		if (input.kind === "hidden") {
			const refs = findBareInputRefs(input.value, "forbids-input-ref");
			for (const ref of refs) {
				errors.push(
					buildError({
						mod,
						moduleUuid,
						ref,
						mode: "forbids-input-ref",
						slot: `caseListConfig.searchInputs[${i}].value`,
						adviceSlotName: `${inputLabel}'s hidden value`,
					}),
				);
			}
			continue;
		}

		// Default value expression — fires before any input is bound,
		// so input refs resolve to empty string regardless of envelope.
		const inputDefault = searchInputDefault(input);
		if (inputDefault !== undefined) {
			const refs = findBareInputRefs(inputDefault, "forbids-input-ref");
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
		if (column === undefined || column.kind !== "calculated") {
			continue;
		}
		const refs = findBareInputRefs(column.expression, "forbids-input-ref");
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
	if (
		searchConfig !== undefined &&
		!isOwnerOnlyCaseSearchConfig(searchConfig) &&
		searchConfig.searchButtonDisplayCondition !== undefined
	) {
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
	const inputName =
		mod.caseListConfig?.searchInputs.find(
			(input) => input.uuid === ref.inputUuid,
		)?.name ?? ref.inputUuid;
	const message =
		mode === "requires-envelope"
			? `Module "${mod.name}" has a bare \`input("${inputName}")\` reference inside ${slot}${at}. CCHQ's runtime resolves an unset input to the empty string, so the wire would match cases whose property equals "" when the user hasn't typed anything yet, not the "filter only when the input has a value" semantic the authoring shape suggests. Open ${adviceSlotName} and wrap the offending subtree in a \`when-input-present(input("${inputName}"), <subtree>)\` envelope so the runtime short-circuits cleanly on an unset input; alternatively, remove the input reference if the predicate isn't supposed to depend on user input.`
			: `Module "${mod.name}" references \`input("${inputName}")\` inside ${slot}${at}. This slot can never see a typed search value: a starting-value expression evaluates before the user has typed, so the reference resolves to the empty string. While the search-button display condition and calculated columns evaluate on the ordinary case list, where the search-input data doesn't exist yet and touching it errors the whole screen on a device (no \`when-input-present\` envelope can guard that, the failure happens before the guard runs). Open ${adviceSlotName} and remove the input reference; if you need the slot to react to a search input, you likely want a different slot (for example \`caseListConfig.filter\` for filtering, or an advanced-arm search-input predicate for input-driven matching).`;
	return validationError(
		"CASE_LIST_BARE_SEARCH_INPUT_REF",
		"module",
		message,
		{ moduleUuid, moduleName: mod.name },
		{ inputUuid: ref.inputUuid, inputName, slot, path: ref.path, mode },
	);
}

/** The unified child inventory carries every reference, including newly recursive
 * field filters and dynamic operands. Only the presence gate changes admission. */
function findBareInputRefs(
	expression: Expression,
	mode: SlotMode,
	searched = false,
): BareRef[] {
	const out: BareRef[] = [];
	const deviceConditions = searched
		? csqlRuntimeRoots(expression).filter((root) => root.within === "query")
		: [];
	const readOnDevice = (path: CheckPath) =>
		deviceConditions.some(
			(root) =>
				root.path.length <= path.length &&
				root.path.every((part, index) => path[index] === part),
		);
	function visit(
		node: Expression | Term,
		path: CheckPath,
		gated: ReadonlySet<Uuid>,
	): void {
		if (node.kind === "input") {
			if (mode === "requires-envelope" && readOnDevice(path)) return;
			if (mode === "forbids-input-ref" || !gated.has(node.searchInputUuid))
				out.push({ inputUuid: node.searchInputUuid, path: path.join(".") });
			return;
		}
		if (node.kind === "when-input-present") {
			const next = new Set(gated);
			if (mode === "requires-envelope") next.add(node.input.searchInputUuid);
			for (const child of expressionChildren(node, path)) {
				if (child.kind === "relation") continue;
				if (
					mode === "requires-envelope" &&
					child.role.kind === "operand" &&
					child.role.slot === "input"
				)
					continue;
				visit(child.value, child.path, next);
			}
			return;
		}
		for (const child of expressionChildren(node, path))
			if (child.kind !== "relation") visit(child.value, child.path, gated);
	}
	visit(expression, [], new Set());
	return out;
}
