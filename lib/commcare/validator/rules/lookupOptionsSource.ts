/** The shared slot checker owns leaf scope, order and type admission. */
import { findOnDeviceDateAddIssueInPredicate } from "@/lib/commcare/expression/onDeviceCompatibility";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	formExpressionFacts,
	slotContext,
} from "@/lib/domain/expression/context";
import { checkExpression } from "@/lib/domain/expression/typeChecker";
import type { Term } from "@/lib/domain/expression/types";
import { walkExpressionTerms } from "@/lib/domain/expression/walk";
import { type ValidationError, validationError } from "../errors";
import {
	checkErrorDetails,
	type LookupTypeIndex,
	semanticCheckErrors,
} from "../lookupTypeContext";

export function validateLookupOptionsSources(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleUuid: Uuid,
	lookupTables: LookupTypeIndex,
): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const uuid of formExpressionFacts(doc, formUuid)?.fields.keys() ?? []) {
		const field = doc.fields[uuid];
		if (
			(field?.kind !== "single_select" && field?.kind !== "multi_select") ||
			field.optionsSource.kind !== "lookup" ||
			field.optionsSource.filter === undefined
		)
			continue;
		const source = field.optionsSource;
		const filter = source.filter;
		if (filter === undefined) continue;
		const ctx = slotContext(
			doc,
			{ entity: "field", uuid, slot: "lookup_options_source" },
			lookupTables,
		);
		if (ctx === undefined)
			throw new Error("A saved lookup choice filter has no owning slot.");
		const loc = {
			moduleUuid,
			moduleName: doc.modules[moduleUuid].name,
			formUuid,
			formName: doc.forms[formUuid].name,
			fieldUuid: uuid,
			fieldId: field.id,
			field: "optionsSource.filter",
		};
		const terms = new Map<string, Term>();
		walkExpressionTerms(filter, (term, path) =>
			terms.set(JSON.stringify(path), term),
		);
		for (const error of semanticCheckErrors(checkExpression(filter, ctx))) {
			const term = terms.get(JSON.stringify(error.path));
			const reason =
				error.code === "case-data-unavailable"
					? "case-data"
					: error.code === "search-answer-unavailable" ||
							error.code === "unknown-search-input"
						? "search-input"
						: error.reason;
			const code =
				error.code === "form-answer-unavailable" &&
				error.reason === "field-not-earlier"
					? "LOOKUP_SELECT_FILTER_FIELD_NOT_EARLIER"
					: error.code === "form-answer-unavailable" &&
							error.reason === "field-repeat-scope"
						? "LOOKUP_SELECT_FILTER_FIELD_REPEAT_SCOPE"
						: [
									"case-data-unavailable",
									"form-answer-unavailable",
									"search-answer-unavailable",
									"unknown-search-input",
								].includes(error.code)
							? "LOOKUP_SELECT_FILTER_TERM_NOT_ALLOWED"
							: "LOOKUP_SELECT_FILTER_TYPE_ERROR";
			errors.push(
				validationError(
					code,
					"field",
					`Lookup choices for "${field.id}": ${error.message}`,
					loc,
					{
						...checkErrorDetails(error),
						tableId: source.tableId,
						...(reason === undefined ? {} : { reason }),
						...(term?.kind === "field"
							? { referencedFieldUuid: term.uuid, target: `field:${term.uuid}` }
							: {}),
					},
				),
			);
		}
		const issue = findOnDeviceDateAddIssueInPredicate(filter, ctx);
		if (issue !== undefined)
			errors.push(
				validationError(
					"LOOKUP_SELECT_FILTER_NOT_ON_DEVICE",
					"field",
					`Lookup choices for "${field.id}" use a date calculation unavailable on device.`,
					loc,
					{
						reason: issue.reason,
						interval: issue.expression.interval,
						tableId: source.tableId,
					},
				),
			);
	}
	return errors;
}
