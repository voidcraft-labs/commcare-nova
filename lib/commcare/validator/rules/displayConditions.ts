import { slotContext } from "@/lib/domain/expression/context";
/**
 * Shared validation for module/form navigation display conditions.
 *
 * The Predicate family is intentionally broader than either menu evaluation
 * context. This rule closes each carrier to values CommCare can actually
 * resolve there instead of treating a generic `TypeContext` as permission to
 * read a case row or a Search prompt:
 *
 *   - module conditions have no case or Search-input context;
 *   - form conditions may read the selected case only when every form in the
 *     module is case-loading (case-first), and only through a direct self read
 *     of that module's case type;
 *   - Search inputs, relation walks, relation presence, and relation counts are
 *     unavailable on both surfaces.
 *
 * Both carriers lower through JavaRosa's on-device XPath evaluator, so the
 * portability checks mirror the existing case-list on-device rules. Raw XPath
 * comparisons are preserved: in particular, an absent node string-unpacks to
 * `""`, while numeric ordering coerces it to NaN. Emission must not add a
 * blanket presence guard that would change equality or inequality semantics.
 */

import {
	findOnDeviceDateAddIssueInPredicate,
	findOnDeviceScalarExpressionIssue,
} from "@/lib/commcare/expression/onDeviceCompatibility";
import { isValidStaticGeopointCenter } from "@/lib/commcare/predicate/geopoint";
import { matchModeRunsOnDevice } from "@/lib/commcare/predicate/matchModes";
import {
	type BlueprintDoc,
	type Form,
	type Module,
	moduleIsCaseFirst,
	type Uuid,
} from "@/lib/domain";
import {
	checkExpression,
	displayConditionStartsWithNever,
	type Expression,
	type ExpressionContext,
	walkConditionArms,
	walkExpressionNodes,
} from "@/lib/domain/expression";
import { type ValidationError, validationError } from "../errors";
import {
	checkErrorDetails,
	type LookupTypeIndex,
	semanticCheckErrors,
} from "../lookupTypeContext";
import { formatPath } from "./case-list/shared";

type Carrier =
	| {
			readonly kind: "module";
			readonly moduleUuid: Uuid;
			readonly mod: Module;
			readonly condition: Expression;
	  }
	| {
			readonly kind: "form";
			readonly moduleUuid: Uuid;
			readonly mod: Module;
			readonly formUuid: Uuid;
			readonly form: Form;
			readonly condition: Expression;
			readonly caseFirst: boolean;
	  };

function location(carrier: Carrier) {
	return carrier.kind === "module"
		? { moduleUuid: carrier.moduleUuid, moduleName: carrier.mod.name }
		: {
				moduleUuid: carrier.moduleUuid,
				moduleName: carrier.mod.name,
				formUuid: carrier.formUuid,
				formName: carrier.form.name,
			};
}

function subject(carrier: Carrier): string {
	return carrier.kind === "module"
		? `Module "${carrier.mod.name}"`
		: `Form "${carrier.form.name}" in module "${carrier.mod.name}"`;
}

function firstPortabilityIssue(
	condition: Expression,
	ctx: ExpressionContext,
):
	| { readonly message: string; readonly details?: Record<string, string> }
	| undefined {
	let issue:
		| { readonly message: string; readonly details?: Record<string, string> }
		| undefined;
	walkConditionArms(condition, (node) => {
		if (issue !== undefined) return;
		if (node.kind === "match" && !matchModeRunsOnDevice(node.mode)) {
			issue = {
				message: `uses the server-only \`${node.mode}\` match mode; use \`starts-with\` or another on-device condition`,
			};
			return;
		}
		if (node.kind === "within-distance") {
			const center = node.center;
			if (
				center.kind === "term" &&
				center.term.kind === "literal" &&
				typeof center.term.value === "string" &&
				!isValidStaticGeopointCenter(center.term.value)
			) {
				issue = {
					message: `uses an invalid fixed geopoint center "${center.term.value}"`,
				};
			}
		}
	});

	if (issue === undefined) {
		const dateAddIssue = findOnDeviceDateAddIssueInPredicate(condition, ctx);
		if (dateAddIssue?.reason === "calendar-interval") {
			issue = {
				message: `adds calendar-relative ${dateAddIssue.expression.interval}, which JavaRosa cannot evaluate faithfully in a menu condition`,
				details: {
					reason: dateAddIssue.reason,
					interval: dateAddIssue.expression.interval,
				},
			};
		} else if (dateAddIssue?.reason === "datetime-base") {
			issue = {
				message:
					"adds to a date-and-time value, which would discard the time on device",
				details: {
					reason: dateAddIssue.reason,
					interval: dateAddIssue.expression.interval,
				},
			};
		}
	}

	walkExpressionNodes(condition, (node) => {
		if (issue !== undefined) return;
		const scalarIssue = findOnDeviceScalarExpressionIssue(node, ctx);
		if (scalarIssue !== undefined) {
			issue = {
				message:
					"uses a relation read that may return several values in one scalar menu expression",
			};
		}
	});
	return issue;
}

function validateCarrier(
	carrier: Carrier,
	doc: BlueprintDoc,
	lookupTables?: LookupTypeIndex,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const loc = location(carrier);
	const who = subject(carrier);
	const ctx = slotContext(
		doc,
		carrier.kind === "module"
			? {
					entity: "module",
					uuid: carrier.moduleUuid,
					slot: "module_display_condition",
				}
			: {
					entity: "form",
					uuid: carrier.formUuid,
					slot: "form_display_condition",
				},
		lookupTables ?? new Map(),
	);
	if (ctx === undefined)
		throw new Error("A saved display condition has no owning slot.");
	const allErrors = semanticCheckErrors(
		checkExpression(carrier.condition, ctx),
	);

	// `never`, or an `and` that starts with it, prints exactly what
	// `hiddenFromMenu` prints, so the flag is the one spelling of "off the
	// menu". A condition that happens to be false anywhere else is ordinary.
	if (displayConditionStartsWithNever(carrier.condition)) {
		const name =
			carrier.kind === "module" ? carrier.mod.name : carrier.form.name;
		errors.push(
			validationError(
				"DISPLAY_CONDITION_USE_HIDDEN_FROM_MENU",
				carrier.kind,
				`"${name}" has a display condition that starts with "never". To keep it off the menu, set hiddenFromMenu to true and keep the rest of the condition.`,
				loc,
				{ name },
			),
		);
	}

	if (
		allErrors.some(
			(error) =>
				error.code === "search-answer-unavailable" ||
				error.code === "unknown-search-input",
		)
	) {
		errors.push(
			validationError(
				"DISPLAY_CONDITION_SEARCH_INPUT_UNAVAILABLE",
				carrier.kind,
				`${who} uses a Search answer in its display condition, but no Search screen is active while navigation items are being shown. Use a session/user value instead.`,
				loc,
			),
		);
	}

	if (allErrors.some((error) => error.code === "case-data-unavailable")) {
		const code =
			carrier.kind === "module"
				? "MODULE_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE"
				: "FORM_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE";
		const explanation =
			carrier.kind === "module"
				? "A module is shown before any case is selected."
				: carrier.caseFirst
					? `Only direct properties of the selected "${carrier.mod.caseType ?? "case"}" case are available there; related cases and case counts are not.`
					: "This module asks the user to choose a form before it selects a case.";
		errors.push(
			validationError(
				code,
				carrier.kind,
				`${who} reads case data in its display condition, but that case context is unavailable. ${explanation}`,
				loc,
			),
		);
	}

	const typeErrors = allErrors.filter(
		(error) =>
			error.code !== "case-data-unavailable" &&
			error.code !== "search-answer-unavailable",
	);
	if (typeErrors.length > 0) {
		const code =
			carrier.kind === "module"
				? "MODULE_DISPLAY_CONDITION_TYPE_ERROR"
				: "FORM_DISPLAY_CONDITION_TYPE_ERROR";
		for (const error of typeErrors) {
			const path = formatPath(error.path);
			errors.push(
				validationError(
					code,
					carrier.kind,
					`${who} has a type error in its display condition${path ? ` (at ${path})` : ""}: ${error.message}`,
					loc,
					checkErrorDetails(error),
				),
			);
		}
	}

	const portability = firstPortabilityIssue(carrier.condition, ctx);
	if (portability !== undefined) {
		errors.push(
			validationError(
				"DISPLAY_CONDITION_NOT_ON_DEVICE",
				carrier.kind,
				`${who} ${portability.message}.`,
				loc,
				portability.details,
			),
		);
	}

	return errors;
}

export function moduleDisplayCondition(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
	lookupTables?: LookupTypeIndex,
): ValidationError[] {
	if (mod.displayCondition === undefined) return [];
	return validateCarrier(
		{ kind: "module", moduleUuid, mod, condition: mod.displayCondition },
		doc,
		lookupTables,
	);
}

export function formDisplayCondition(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleUuid: Uuid,
	lookupTables?: LookupTypeIndex,
): ValidationError[] {
	const form = doc.forms[formUuid];
	if (form.displayCondition === undefined) return [];
	const mod = doc.modules[moduleUuid];
	return validateCarrier(
		{
			kind: "form",
			moduleUuid,
			mod,
			formUuid,
			form,
			condition: form.displayCondition,
			caseFirst: moduleIsCaseFirst(doc, moduleUuid),
		},
		doc,
		lookupTables,
	);
}
