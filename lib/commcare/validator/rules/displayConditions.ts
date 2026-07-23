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

import { findOnDeviceScalarExpressionIssue } from "@/lib/commcare/expression/onDeviceCompatibility";
import { isValidStaticGeopointCenter } from "@/lib/commcare/predicate";
import type { BlueprintDoc, Form, Module, Uuid } from "@/lib/domain";
import { isCaseFirstModule } from "@/lib/domain";
import {
	checkExpression,
	checkPredicate,
	isMatchNone,
	type Predicate,
	type PropertyRef,
	simplifyForEmission,
	type TypeContext,
	walkPredicateExpressionNodes,
	walkPredicateNodes,
	walkTerms,
} from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../errors";
import {
	type LookupTypeIndex,
	semanticCheckErrors,
} from "../lookupTypeContext";
import { formatPath, moduleTypeContext } from "./case-list/shared";

type Carrier =
	| {
			readonly kind: "module";
			readonly moduleUuid: Uuid;
			readonly mod: Module;
			readonly condition: Predicate;
	  }
	| {
			readonly kind: "form";
			readonly moduleUuid: Uuid;
			readonly mod: Module;
			readonly formUuid: Uuid;
			readonly form: Form;
			readonly condition: Predicate;
			readonly caseFirst: boolean;
	  };

const CSQL_ONLY_MATCH_MODES = new Set(["fuzzy", "phonetic", "fuzzy-date"]);

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

function hasSearchInputReference(condition: Predicate): boolean {
	let found = false;
	walkTerms(condition, (term) => {
		if (term.kind === "input") found = true;
	});
	return found;
}

function propertyAllowedOnForm(
	property: PropertyRef,
	carrier: Extract<Carrier, { kind: "form" }>,
): boolean {
	return (
		carrier.caseFirst &&
		carrier.mod.caseType !== undefined &&
		property.caseType === carrier.mod.caseType &&
		(property.via === undefined || property.via.kind === "self")
	);
}

function hasUnavailableCaseRead(carrier: Carrier): boolean {
	let unavailable = false;
	walkTerms(carrier.condition, (term) => {
		if (term.kind !== "prop") return;
		if (carrier.kind === "module" || !propertyAllowedOnForm(term, carrier)) {
			unavailable = true;
		}
	});
	walkPredicateExpressionNodes(carrier.condition, (node) => {
		if (node.kind === "count") unavailable = true;
	});
	walkPredicateNodes(carrier.condition, (node) => {
		if (node.kind === "exists" || node.kind === "missing") unavailable = true;
	});
	return unavailable;
}

function firstPortabilityIssue(
	condition: Predicate,
	ctx: TypeContext,
): string | undefined {
	let issue: string | undefined;
	walkPredicateNodes(condition, (node) => {
		if (issue !== undefined) return;
		if (node.kind === "is-null") {
			issue =
				"uses strict `is-null`, but CommCare cannot distinguish a missing value from a stored blank in this menu expression; use `is-blank`";
			return;
		}
		if (node.kind === "match" && CSQL_ONLY_MATCH_MODES.has(node.mode)) {
			issue = `uses the server-only \`${node.mode}\` match mode; use \`starts-with\` or another on-device condition`;
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
				issue = `uses an invalid fixed geopoint center "${center.term.value}"`;
			}
		}
	});

	walkPredicateExpressionNodes(condition, (node) => {
		if (issue !== undefined) return;
		if (node.kind === "unwrap-list") {
			issue =
				"uses `unwrap-list`, which exists only in CommCare's server-side search grammar";
			return;
		}
		if (node.kind === "date-add") {
			if (node.interval === "months" || node.interval === "years") {
				issue = `adds calendar-relative ${node.interval}, which JavaRosa cannot evaluate faithfully in a menu condition`;
				return;
			}
			const operandErrors: Parameters<typeof checkExpression>[2] = [];
			if (checkExpression(node.date, ctx, operandErrors, []) === "datetime") {
				issue =
					"adds to a date-and-time value, which would discard the time on device";
				return;
			}
		}
		const scalarIssue = findOnDeviceScalarExpressionIssue(node, ctx);
		if (scalarIssue !== undefined) {
			issue =
				scalarIssue.reason === "unwrap-list"
					? "uses `unwrap-list`, which exists only in CommCare's server-side search grammar"
					: scalarIssue.reason === "table-lookup"
						? "uses a table lookup, but lookup-table expressions are dormant until fixture emission lands and cannot run in an on-device navigation condition"
						: "uses a relation read that may return several values in one scalar menu expression";
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

	if (isMatchNone(simplifyForEmission(carrier.condition))) {
		errors.push(
			validationError(
				"DISPLAY_CONDITION_ALWAYS_FALSE",
				carrier.kind,
				`${who} has a display condition that is always false, so nobody could open it. Remove the item or change the condition.`,
				loc,
			),
		);
	}

	if (hasSearchInputReference(carrier.condition)) {
		errors.push(
			validationError(
				"DISPLAY_CONDITION_SEARCH_INPUT_UNAVAILABLE",
				carrier.kind,
				`${who} uses a Search answer in its display condition, but no Search screen is active while navigation items are being shown. Use a session/user value instead.`,
				loc,
			),
		);
	}

	if (hasUnavailableCaseRead(carrier)) {
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

	const ctx = moduleTypeContext(carrier.mod, doc, lookupTables);
	const typeErrors = semanticCheckErrors(
		checkPredicate(carrier.condition, ctx),
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
					{ path },
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
				`${who} ${portability}.`,
				loc,
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
	const formTypes = (doc.formOrder[moduleUuid] ?? [])
		.map((uuid) => doc.forms[uuid]?.type)
		.filter((type): type is Form["type"] => type !== undefined);
	return validateCarrier(
		{
			kind: "form",
			moduleUuid,
			mod,
			formUuid,
			form,
			condition: form.displayCondition,
			caseFirst: isCaseFirstModule(formTypes, mod.caseType !== undefined),
		},
		doc,
		lookupTables,
	);
}
