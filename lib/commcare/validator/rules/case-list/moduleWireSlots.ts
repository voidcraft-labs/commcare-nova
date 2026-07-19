/**
 * The module-level wire-slot inventory shared by the dialect-portability
 * rules (`strictNullPortability`, `dateAddOnDeviceCompatibility`,
 * `matchModeOnDeviceCompatibility`, `onDeviceExpressionCompatibility`).
 *
 * One walk enumerates every module-carried Predicate/ValueExpression slot
 * that reaches a CommCare wire surface, in emission order:
 *
 *   - the effective case-list filter (after wire simplification),
 *   - calculated-column expressions (scope selected per rule below),
 *   - every search-input default,
 *   - each advanced search-input's effective predicate,
 *   - the assigned-cases / excluded-owner expression, and
 *   - the simplified search-button display condition.
 *
 * Each slot carries its identity — the doc path, the human-readable label
 * used in messages, the `surface` tag stamped into finding details, and the
 * owning input/column identity — so consumers only supply per-slot judgment.
 *
 * Two axes are per-rule:
 *
 *   - `calculatedColumns` — `"runtime"` visits only calculated columns with
 *     a list/detail/sort runtime role (the emitted set); `"all-definitions"`
 *     also visits latent definitions, for rules that must reject a saved
 *     expression before a later visibility or sort change activates it.
 *   - the predicate dialect — the filter and the search-button display
 *     condition lower through on-device JavaRosa XPath (`judgePredicate`),
 *     while an advanced input's predicate lowers through the mixed-dialect
 *     CSQL emitter (`judgeCsqlPredicate`). A rule whose judgment is
 *     dialect-independent passes the same function for both.
 *
 * The walk also owns the match-none absorption: the filter and advanced
 * predicates AND-compose into one CSQL query, and a match-none clause
 * absorbs that composition, so findings against sibling advanced predicates
 * never reach the wire and are dropped. The filter keeps its finding — it
 * still emits independently on-device.
 */

import {
	caseListColumnHasRuntimeRole,
	type Module,
	type Uuid,
} from "@/lib/domain";
import {
	effectiveFilterForEmission,
	type Predicate,
	simplifyForEmission,
	type ValueExpression,
} from "@/lib/domain/predicate";
import type { ValidationError } from "../../errors";

export type ModuleWireSlotSurface =
	| "filter"
	| "calculated-column"
	| "search-input-default"
	| "advanced-input"
	| "excluded-owner-ids"
	| "search-button";

export interface ModuleWireSlotIdentity {
	readonly mod: Module;
	readonly moduleUuid: Uuid;
	readonly slot: string;
	readonly slotLabel: string;
	readonly surface: ModuleWireSlotSurface;
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

export interface ModuleWireSlotJudge {
	readonly calculatedColumns: "runtime" | "all-definitions";
	/** On-device predicate slots: the effective case-list filter and the
	 * simplified search-button display condition. At most one finding per
	 * slot. */
	judgePredicate(
		predicate: Predicate,
		slot: ModuleWireSlotIdentity,
	): ValidationError | undefined;
	/** An advanced search-input's effective predicate, which lowers through
	 * the mixed-dialect CSQL emitter. */
	judgeCsqlPredicate(
		predicate: Predicate,
		slot: ModuleWireSlotIdentity,
	): ValidationError | undefined;
	/** ValueExpression slots: calculated columns, search-input defaults, and
	 * the excluded-owner expression. */
	judgeExpression(
		expression: ValueExpression,
		slot: ModuleWireSlotIdentity,
	): ValidationError | undefined;
}

export function collectModuleWireSlotFindings(
	mod: Module,
	moduleUuid: Uuid,
	judge: ModuleWireSlotJudge,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const csqlPredicates: Predicate[] = [];
	const collect = (error: ValidationError | undefined): void => {
		if (error !== undefined) errors.push(error);
	};

	const filter = effectiveFilterForEmission(mod.caseListConfig?.filter);
	if (filter !== undefined) {
		csqlPredicates.push(filter);
		collect(
			judge.judgePredicate(filter, {
				mod,
				moduleUuid,
				slot: "caseListConfig.filter",
				slotLabel: "the Cases available rule",
				surface: "filter",
			}),
		);
	}

	const columns = mod.caseListConfig?.columns ?? [];
	for (let index = 0; index < columns.length; index += 1) {
		const column = columns[index];
		if (column.kind !== "calculated") continue;
		if (
			judge.calculatedColumns === "runtime" &&
			!caseListColumnHasRuntimeRole(column)
		) {
			continue;
		}
		const label = column.header || "Untitled field";
		collect(
			judge.judgeExpression(column.expression, {
				mod,
				moduleUuid,
				slot: `caseListConfig.columns[${index}].expression`,
				slotLabel: `calculated field "${label}"`,
				surface: "calculated-column",
				column: { uuid: column.uuid, label },
			}),
		);
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
			collect(
				judge.judgeExpression(input.default, {
					mod,
					moduleUuid,
					slot: `caseListConfig.searchInputs[${index}].default`,
					slotLabel: `the default for search field "${inputIdentity.label}"`,
					surface: "search-input-default",
					input: inputIdentity,
				}),
			);
		}
		if (input.kind !== "advanced") continue;
		const effective = effectiveFilterForEmission(input.predicate);
		if (effective === undefined) continue;
		csqlPredicates.push(effective);
		collect(
			judge.judgeCsqlPredicate(effective, {
				mod,
				moduleUuid,
				slot: `caseListConfig.searchInputs[${index}].predicate`,
				slotLabel: `advanced search input "${inputIdentity.label}"`,
				surface: "advanced-input",
				input: inputIdentity,
			}),
		);
	}

	if (csqlPredicates.some((predicate) => predicate.kind === "match-none")) {
		for (let index = errors.length - 1; index >= 0; index -= 1) {
			if (errors[index].details?.surface === "advanced-input") {
				errors.splice(index, 1);
			}
		}
	}

	const searchConfig = mod.caseSearchConfig;
	if (searchConfig?.excludedOwnerIds !== undefined) {
		collect(
			judge.judgeExpression(searchConfig.excludedOwnerIds, {
				mod,
				moduleUuid,
				slot: "caseSearchConfig.excludedOwnerIds",
				slotLabel: "the assigned-cases setting",
				surface: "excluded-owner-ids",
			}),
		);
	}

	if (searchConfig?.searchButtonDisplayCondition !== undefined) {
		collect(
			judge.judgePredicate(
				simplifyForEmission(searchConfig.searchButtonDisplayCondition),
				{
					mod,
					moduleUuid,
					slot: "caseSearchConfig.searchButtonDisplayCondition",
					slotLabel: "the search-button display condition",
					surface: "search-button",
				},
			),
		);
	}

	return errors;
}
