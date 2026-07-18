/**
 * Rule: no module-level Predicate/ValueExpression slot emitted to CommCare may
 * use Nova's strict `is-null` semantics.
 *
 * Nova's Preview/Postgres evaluator can distinguish an absent property from a
 * property recorded as the empty string. CommCare's emitted case-list/search
 * expression dialects cannot: both states collapse to the portable
 * `property = ''` test. Emitting `is-null` there would therefore make Preview
 * and the exported app disagree.
 *
 * Every module-carried AST wire slot is enumerated here: the case-list filter,
 * calculated-column expressions with a runtime role, advanced search-input
 * predicates, every search-input default, excluded-owner expressions, and the
 * search-button display condition. The canonical predicate/expression walkers
 * cross predicates nested inside every ValueExpression carrier, so an
 * `is-null` hidden in an `if` condition cannot bypass the rule.
 */

import {
	type BlueprintDoc,
	caseListColumnHasRuntimeRole,
	type Module,
	type Uuid,
} from "@/lib/domain";
import {
	effectiveFilterForEmission,
	type Predicate,
	simplifyForEmission,
	type ValueExpression,
	walkExpressionPredicateNodes,
	walkPredicateNodes,
} from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";

type StrictNullPredicate = Extract<Predicate, { kind: "is-null" }>;

export function strictNullPortability(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const csqlPredicates: Predicate[] = [];

	const filter = effectiveFilterForEmission(mod.caseListConfig?.filter);
	if (filter !== undefined) {
		csqlPredicates.push(filter);
		addPredicateError(errors, filter, {
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
		addExpressionError(errors, column.expression, {
			mod,
			moduleUuid,
			slot: `caseListConfig.columns[${index}].expression`,
			slotLabel: `calculated field "${column.header || "Untitled field"}"`,
			surface: "calculated-column",
			column: { uuid: column.uuid, label: column.header || "Untitled field" },
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
			addExpressionError(errors, input.default, {
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
		addPredicateError(errors, effective, {
			mod,
			moduleUuid,
			slot: `caseListConfig.searchInputs[${index}].predicate`,
			slotLabel: `advanced search input "${inputIdentity.label}"`,
			surface: "advanced-input",
			input: inputIdentity,
		});
	}

	// The filter + advanced predicates are AND-composed into one CSQL query.
	// A match-none clause absorbs the entire composition, so strict-null nodes
	// in sibling advanced predicates are dead. The filter still independently
	// runs on-device, so its portability finding must remain.
	if (csqlPredicates.some((predicate) => predicate.kind === "match-none")) {
		for (let index = errors.length - 1; index >= 0; index -= 1) {
			if (errors[index].details?.surface === "advanced-input") {
				errors.splice(index, 1);
			}
		}
	}

	const searchConfig = mod.caseSearchConfig;
	if (searchConfig?.excludedOwnerIds !== undefined) {
		addExpressionError(errors, searchConfig.excludedOwnerIds, {
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
	slot: SlotIdentity,
): void {
	const offender = firstStrictNull(predicate);
	if (offender !== undefined) errors.push(buildError(slot, offender));
}

function addExpressionError(
	errors: ValidationError[],
	expression: ValueExpression,
	slot: SlotIdentity,
): void {
	const offender = firstStrictNullInExpression(expression);
	if (offender !== undefined) errors.push(buildError(slot, offender));
}

function firstStrictNull(
	predicate: Predicate,
): StrictNullPredicate | undefined {
	let offender: StrictNullPredicate | undefined;
	walkPredicateNodes(predicate, (node) => {
		if (offender === undefined && node.kind === "is-null") offender = node;
	});
	return offender;
}

function firstStrictNullInExpression(
	expression: ValueExpression,
): StrictNullPredicate | undefined {
	let offender: StrictNullPredicate | undefined;
	walkExpressionPredicateNodes(expression, (node) => {
		if (offender === undefined && node.kind === "is-null") offender = node;
	});
	return offender;
}

function buildError(
	args: SlotIdentity,
	offender: StrictNullPredicate,
): ValidationError {
	const left = offender.left;
	const property =
		left.kind === "term" && left.term.kind === "prop"
			? left.term.property
			: undefined;
	return validationError(
		"CASE_LIST_STRICT_NULL_NOT_PORTABLE",
		"module",
		`Module "${args.mod.name}" uses a strict \`is-null\` condition${property ? ` on case property "${property}"` : ""} in ${args.slotLabel}, but CommCare treats a value that was never recorded and one recorded as blank as the same in this emitted expression. Use \`is-blank\` so Preview and the exported app agree.`,
		{ moduleUuid: args.moduleUuid, moduleName: args.mod.name },
		{
			slot: args.slot,
			surface: args.surface,
			...(property !== undefined ? { property } : {}),
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
