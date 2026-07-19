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
 * The slot inventory lives in `moduleWireSlots.ts` and mirrors the actual
 * emitters rather than the presence of an authored definition.
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
import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import {
	type Predicate,
	type ValueExpression,
	walkExpressionPredicateNodes,
	walkPredicateNodes,
} from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";
import {
	collectModuleWireSlotFindings,
	type ModuleWireSlotIdentity,
} from "./moduleWireSlots";

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
	return collectModuleWireSlotFindings(mod, moduleUuid, {
		calculatedColumns: "runtime",
		judgePredicate(predicate, slot) {
			const offender = firstCsqlOnlyMatch(predicate);
			return offender === undefined ? undefined : buildError(slot, offender);
		},
		judgeCsqlPredicate(predicate, slot) {
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
			return offender === undefined ? undefined : buildError(slot, offender);
		},
		judgeExpression(expression, slot) {
			const offender = firstCsqlOnlyMatchInExpression(expression);
			return offender === undefined ? undefined : buildError(slot, offender);
		},
	});
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
	args: ModuleWireSlotIdentity,
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
