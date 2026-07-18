/**
 * Rule: keep CSQL-only match modes out of every module AST slot that lowers
 * through JavaRosa's on-device XPath evaluator.
 *
 * Local wire-source audit (2026-07-17): commcare-core registers
 * `XPathStartsWithFunc.NAME` in `FunctionUtils` and dispatches it from
 * `ASTNodeFunctionCall`, but contains no `fuzzy-match`, `phonetic-match`, or
 * `fuzzy-date` implementation. Those three functions instead live in CCHQ's
 * server-side case-search function registry. Letting one reach an on-device
 * slot makes the exported module fail at runtime rather than merely changing
 * how it matches.
 *
 * The inventory mirrors the actual emitters rather than the presence of an
 * authored definition:
 *
 *   - the effective case-list filter (after wire simplification),
 *   - calculated columns that have a list/detail/sort runtime role,
 *   - every simple or advanced search-input default,
 *   - the assigned-cases / excluded-owner expression, and
 *   - the simplified search-button display condition.
 *
 * An advanced input's direct predicate operators lower through server-side
 * CSQL, so a direct fuzzy/phonetic/fuzzy-date match remains valid. CSQL is a
 * mixed-runtime wrapper, however: non-native ValueExpression roots inline as
 * JavaRosa XPath inside the outer `concat(...)`. The shared dialect-state
 * walker therefore inventories only predicate nodes below those runtime
 * boundaries (including `if.cond` and a non-native `count.where`). A direct
 * comparison-LHS subcase count remains native CSQL, including its where
 * predicate. The input's `default` is independently on-device through the
 * `<prompt default="...">` XPath attribute.
 */

import { walkCsqlOnDeviceNodes } from "@/lib/commcare/predicate";
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

type MatchPredicate = Extract<Predicate, { kind: "match" }>;
type DisallowedMode = "fuzzy" | "phonetic" | "fuzzy-date";

const CSQL_ONLY_MODES: readonly DisallowedMode[] = [
	"fuzzy",
	"phonetic",
	"fuzzy-date",
];

function isCsqlOnlyMode(mode: string): mode is DisallowedMode {
	return (CSQL_ONLY_MODES as readonly string[]).includes(mode);
}

export function matchModeOnDeviceCompatibility(
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
		const label = column.header || "Untitled field";
		addExpressionError(errors, column.expression, {
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
		addCsqlPredicateError(errors, effective, {
			mod,
			moduleUuid,
			slot: `caseListConfig.searchInputs[${index}].predicate`,
			slotLabel: `advanced search input "${inputIdentity.label}"`,
			surface: "advanced-input",
			input: inputIdentity,
		});
	}

	// The filter and advanced predicates AND-compose into one CSQL query. An
	// effective match-none clause absorbs that composition, so runtime fragments
	// inside sibling advanced predicates never reach the wire. The filter still
	// emits independently on-device, so retain its own finding.
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
	const offender = firstCsqlOnlyMatch(predicate);
	if (offender !== undefined) errors.push(buildError(slot, offender));
}

function addExpressionError(
	errors: ValidationError[],
	expression: ValueExpression,
	slot: SlotIdentity,
): void {
	const offender = firstCsqlOnlyMatchInExpression(expression);
	if (offender !== undefined) errors.push(buildError(slot, offender));
}

function addCsqlPredicateError(
	errors: ValidationError[],
	predicate: Predicate,
	slot: SlotIdentity,
): void {
	let offender: MatchPredicate | undefined;
	walkCsqlOnDeviceNodes(predicate, {
		visitPredicate(node) {
			if (
				offender === undefined &&
				node.kind === "match" &&
				isCsqlOnlyMode(node.mode)
			) {
				offender = node;
			}
		},
	});
	if (offender !== undefined) errors.push(buildError(slot, offender));
}

/** One finding per emitted slot is enough to block the invalid document and
 * points the editor at the one place that needs repair. Reporting every nested
 * match from the same expression produces duplicate cards with the same fix. */
function firstCsqlOnlyMatch(predicate: Predicate): MatchPredicate | undefined {
	let offender: MatchPredicate | undefined;
	walkPredicateNodes(predicate, (node) => {
		if (
			offender === undefined &&
			node.kind === "match" &&
			isCsqlOnlyMode(node.mode)
		) {
			offender = node;
		}
	});
	return offender;
}

function firstCsqlOnlyMatchInExpression(
	expression: ValueExpression,
): MatchPredicate | undefined {
	let offender: MatchPredicate | undefined;
	walkExpressionPredicateNodes(expression, (node) => {
		if (
			offender === undefined &&
			node.kind === "match" &&
			isCsqlOnlyMode(node.mode)
		) {
			offender = node;
		}
	});
	return offender;
}

function buildError(
	args: SlotIdentity,
	match: MatchPredicate,
): ValidationError {
	const repair =
		args.surface === "filter"
			? "Use `starts-with` in this setting, or move this matching rule into an advanced search condition if it needs the server-side match type."
			: "Use `starts-with` or choose another condition that can run on the device.";
	return validationError(
		"CASE_LIST_MATCH_MODE_NOT_ON_DEVICE",
		"module",
		`Module "${args.mod.name}" uses a \`${match.mode}\` match on case property "${match.property.property}" in ${args.slotLabel}, but that setting runs on the device and CommCare only provides \`starts-with\` there. ${repair}`,
		{ moduleUuid: args.moduleUuid, moduleName: args.mod.name },
		{
			mode: match.mode,
			property: match.property.property,
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
