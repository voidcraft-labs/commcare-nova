/**
 * Rule: admit only portable date arithmetic in module AST slots that lower
 * through JavaRosa's on-device XPath evaluator.
 *
 * Local CommCare Core audit (2026-07-17): `ASTNodeFunctionCall` and
 * `FunctionUtils` register neither `date-add` nor `datetime-add`. Core can add
 * fixed-duration intervals portably through ordinary arithmetic because
 * `XPathArithExpr` coerces a Date to epoch days, `XPathFloorFunc` applies
 * mathematical floor, and `date(...)` converts the result back to a Date.
 * That path is faithful when:
 *
 *   - the interval is seconds, minutes, hours, days, or weeks; and
 *   - the base resolves to `date`, not `datetime`.
 *
 * `FunctionUtils.toNumeric(Date)` uses integer `DateUtils.daysSinceEpoch`, so
 * applying the fallback to a datetime silently discards its time-of-day.
 * `floor(base + scaledQuantity)` is required before `FunctionUtils.toDate`:
 * the latter truncates toward zero, which diverges from CCHQ date results for
 * negative fractions and dates before 1970. Months and years are calendar
 * relative and have no faithful fixed-day operator lowering.
 *
 * The inventory mirrors the actual on-device emitters:
 *
 *   - the effective case-list filter (after wire simplification),
 *   - calculated columns with a list/detail/sort runtime role,
 *   - every simple or advanced search-input default,
 *   - the assigned-cases / excluded-owner expression, and
 *   - the simplified search-button display condition.
 *
 * Advanced predicates are mixed-dialect rather than uniformly server-side:
 * direct CSQL-native `date-add` nodes stay on the server, while a `date-add`
 * below a non-native value root (for example `if` or `arith`) is interpolated
 * through JavaRosa. The dialect-state walker mirrors that dispatch. An input's
 * default remains wholly in scope because `<prompt default>` is evaluated
 * on-device.
 */

import { walkCsqlOnDeviceNodes } from "@/lib/commcare/predicate";
import {
	type BlueprintDoc,
	caseListColumnHasRuntimeRole,
	type Module,
	type Uuid,
} from "@/lib/domain";
import {
	checkExpression,
	effectiveFilterForEmission,
	type Predicate,
	simplifyForEmission,
	type TypeContext,
	type ValueExpression,
	walkExpressionNodes,
	walkPredicateExpressionNodes,
} from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";
import { moduleTypeContext } from "./shared";

type DateAddExpression = Extract<ValueExpression, { kind: "date-add" }>;
type IncompatibilityReason = "calendar-interval" | "datetime-base";

interface IncompatibleDateAdd {
	readonly expression: DateAddExpression;
	readonly reason: IncompatibilityReason;
}

export function dateAddOnDeviceCompatibility(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const ctx = moduleTypeContext(mod, doc);
	const csqlPredicates: Predicate[] = [];

	const filter = effectiveFilterForEmission(mod.caseListConfig?.filter);
	if (filter !== undefined) {
		csqlPredicates.push(filter);
		addPredicateError(errors, filter, ctx, {
			mod,
			moduleUuid,
			slot: "caseListConfig.filter",
			slotLabel: "the Cases available rule",
			surface: "filter",
		});
	}

	const columns = mod.caseListConfig?.columns ?? [];
	for (let index = 0; index < columns.length; index += 1) {
		const column = columns[index];
		if (column.kind !== "calculated" || !caseListColumnHasRuntimeRole(column)) {
			continue;
		}
		const label = column.header || "Untitled field";
		addExpressionError(errors, column.expression, ctx, {
			mod,
			moduleUuid,
			slot: `caseListConfig.columns[${index}].expression`,
			slotLabel: `calculated field "${label}"`,
			surface: "calculated-column",
			column: { uuid: column.uuid, label },
		});
	}

	const inputs = mod.caseListConfig?.searchInputs ?? [];
	for (let index = 0; index < inputs.length; index += 1) {
		const input = inputs[index];
		const inputIdentity = {
			uuid: input.uuid,
			name: input.name,
			label: input.label || input.name,
		};
		if (input.default !== undefined) {
			addExpressionError(errors, input.default, ctx, {
				mod,
				moduleUuid,
				slot: `caseListConfig.searchInputs[${index}].default`,
				slotLabel: `the default for search field "${inputIdentity.label}"`,
				surface: "search-input-default",
				input: inputIdentity,
			});
		}
		if (input.kind !== "advanced") continue;
		const effective = effectiveFilterForEmission(input.predicate);
		if (effective === undefined) continue;
		csqlPredicates.push(effective);
		addCsqlPredicateError(errors, effective, ctx, {
			mod,
			moduleUuid,
			slot: `caseListConfig.searchInputs[${index}].predicate`,
			slotLabel: `advanced search input "${inputIdentity.label}"`,
			surface: "advanced-input",
			input: inputIdentity,
		});
	}

	// The filter and advanced predicates are AND-composed for CSQL. A
	// match-none clause absorbs that server query, so on-device fragments inside
	// sibling advanced predicates are never emitted. The filter still has an
	// independent on-device role, so only advanced-input findings are removed.
	if (csqlPredicates.some((predicate) => predicate.kind === "match-none")) {
		for (let index = errors.length - 1; index >= 0; index -= 1) {
			if (errors[index].details?.surface === "advanced-input") {
				errors.splice(index, 1);
			}
		}
	}

	const searchConfig = mod.caseSearchConfig;
	if (searchConfig?.excludedOwnerIds !== undefined) {
		addExpressionError(errors, searchConfig.excludedOwnerIds, ctx, {
			mod,
			moduleUuid,
			slot: "caseSearchConfig.excludedOwnerIds",
			slotLabel: "the assigned-cases setting",
			surface: "excluded-owner-ids",
		});
	}

	if (searchConfig?.searchButtonDisplayCondition !== undefined) {
		addPredicateError(
			errors,
			simplifyForEmission(searchConfig.searchButtonDisplayCondition),
			ctx,
			{
				mod,
				moduleUuid,
				slot: "caseSearchConfig.searchButtonDisplayCondition",
				slotLabel: "the search-button display condition",
				surface: "search-button",
			},
		);
	}

	return errors;
}

interface SlotIdentity {
	readonly mod: Module;
	readonly moduleUuid: Uuid;
	readonly slot: string;
	readonly slotLabel: string;
	readonly surface: string;
	readonly input?: {
		readonly uuid: Uuid;
		readonly name: string;
		readonly label: string;
	};
	readonly column?: {
		readonly uuid: Uuid;
		readonly label: string;
	};
}

function addPredicateError(
	errors: ValidationError[],
	predicate: Predicate,
	ctx: TypeContext,
	slot: SlotIdentity,
): void {
	const offender = firstIncompatibleDateAddInPredicate(predicate, ctx);
	if (offender !== undefined) errors.push(buildError(slot, offender));
}

function addExpressionError(
	errors: ValidationError[],
	expression: ValueExpression,
	ctx: TypeContext,
	slot: SlotIdentity,
): void {
	const offender = firstIncompatibleDateAdd(expression, ctx);
	if (offender !== undefined) errors.push(buildError(slot, offender));
}

function addCsqlPredicateError(
	errors: ValidationError[],
	predicate: Predicate,
	ctx: TypeContext,
	slot: SlotIdentity,
): void {
	let offender: IncompatibleDateAdd | undefined;
	walkCsqlOnDeviceNodes(predicate, {
		visitExpression(node) {
			if (offender !== undefined || node.kind !== "date-add") return;
			offender = incompatibilityFor(node, ctx);
		},
	});
	if (offender !== undefined) errors.push(buildError(slot, offender));
}

/** One finding per emitted slot gives the author one stable repair target
 * without repeating the same card for every nested date-add node. */
function firstIncompatibleDateAddInPredicate(
	predicate: Predicate,
	ctx: TypeContext,
): IncompatibleDateAdd | undefined {
	let offender: IncompatibleDateAdd | undefined;
	walkPredicateExpressionNodes(predicate, (node) => {
		if (offender !== undefined || node.kind !== "date-add") return;
		offender = incompatibilityFor(node, ctx);
	});
	return offender;
}

function firstIncompatibleDateAdd(
	expression: ValueExpression,
	ctx: TypeContext,
): IncompatibleDateAdd | undefined {
	let offender: IncompatibleDateAdd | undefined;
	walkExpressionNodes(expression, (node) => {
		if (offender !== undefined || node.kind !== "date-add") return;
		offender = incompatibilityFor(node, ctx);
	});
	return offender;
}

function incompatibilityFor(
	expression: DateAddExpression,
	ctx: TypeContext,
): IncompatibleDateAdd | undefined {
	if (expression.interval === "months" || expression.interval === "years") {
		return { expression, reason: "calendar-interval" };
	}

	// The ordinary type-check rules own malformed date operands. This rule only
	// adds the portability finding when the otherwise-valid base is a datetime.
	const operandErrors: Parameters<typeof checkExpression>[2] = [];
	const operandType = checkExpression(expression.date, ctx, operandErrors, []);
	if (operandType === "datetime") {
		return { expression, reason: "datetime-base" };
	}

	return undefined;
}

function buildError(
	args: SlotIdentity,
	offender: IncompatibleDateAdd,
): ValidationError {
	const interval = offender.expression.interval;
	const message = (() => {
		switch (offender.reason) {
			case "datetime-base":
				return `Module "${args.mod.name}" uses a date and time in ${args.slotLabel}, but this calculation only supports whole dates here, so the time would be lost. Use a date without a time or rewrite the calculation.`;
			case "calendar-interval":
				return `Module "${args.mod.name}" adds ${interval} in ${args.slotLabel}, but CommCare can't use month or year calculations here. Use seconds, minutes, hours, days, or weeks. To use months or years, put the comparison directly in a search condition.`;
			default: {
				const _exhaustive: never = offender.reason;
				throw new Error(`Unhandled date-add incompatibility ${_exhaustive}`);
			}
		}
	})();

	return validationError(
		"CASE_LIST_DATE_ADD_NOT_ON_DEVICE",
		"module",
		message,
		{ moduleUuid: args.moduleUuid, moduleName: args.mod.name },
		{
			reason: offender.reason,
			interval,
			slot: args.slot,
			surface: args.surface,
			...(args.input !== undefined
				? {
						inputUuid: args.input.uuid,
						inputName: args.input.name,
						inputLabel: args.input.label,
					}
				: {}),
			...(args.column !== undefined
				? {
						columnUuid: args.column.uuid,
						columnLabel: args.column.label,
					}
				: {}),
		},
	);
}
