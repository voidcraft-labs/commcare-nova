import { slotContext } from "@/lib/domain/expression/context";
import { formFieldPath } from "@/lib/domain/expression/formStructure";
import type { FormPrintContext } from "@/lib/domain/expression/print";
import {
	locationPropertiesOf,
	organizationLevelsOf,
} from "@/lib/domain/organization";
import { referenceNames } from "@/lib/domain/referenceNames";
import {
	entryDatumIdResolver,
	entryDatumIds,
	formLinkProjectionContext,
} from "../formLinkProjection";
import { itextIdFor } from "../xform/itextIds";
import { formNodeProjection } from "./formNodeProjection";
import type { FormParseScope } from "./formParseScope";

export function formScopeContext(scope: FormParseScope) {
	return slotContext(
		scope.doc,
		scope.slot,
		scope.lookup === "unavailable"
			? new Map()
			: new Map(
					[...scope.lookup].map(([id, table]) => [
						id,
						new Map(
							table.columns.map((column) => [column.id, column.dataType]),
						),
					]),
				),
		{ form: scope.form },
	);
}

/** Parser hints and all human projections use this same identity projection. */
export function formPrintContext(
	scope: FormParseScope,
): FormPrintContext | undefined {
	const context = formScopeContext(scope);
	if (context === undefined) return undefined;
	const form = context.form;
	const names = referenceNames(scope.doc);
	const projection =
		form === undefined ? undefined : formNodeProjection(scope.doc, form);
	const datums =
		form === undefined
			? []
			: entryDatumIds(
					scope.doc,
					formLinkProjectionContext(scope.doc, { entryMetadataOnly: true }),
					form.moduleUuid,
					form.formUuid,
				);
	const datumId = entryDatumIdResolver(datums);
	return {
		...names,
		...(projection === undefined
			? {}
			: { graph: projection.graph, step: projection.step }),
		sourceNode: context.sourceNode,
		contextNode: context.contextNode,
		fieldPathSegments: (uuid) =>
			form === undefined
				? names.fieldPathSegments(uuid)
				: formFieldPath(form, uuid),
		choiceValues: (field, options) => {
			const choices = form?.fields.get(field)?.choices;
			if (choices?.kind !== "inline") return undefined;
			const values = options.map(
				(uuid) => choices.options.find((option) => option.uuid === uuid)?.value,
			);
			return values.every((value): value is string => value !== undefined)
				? values
				: undefined;
		},
		datumId,
		selectedCasesId: (module) =>
			datums.find(
				(row) =>
					!row.scalar &&
					row.refs.some(
						(ref) => ref.kind === "selected-case" && ref.module === module,
					),
			)?.id,
		tableTag: (table) =>
			scope.lookup === "unavailable" ? undefined : scope.lookup.get(table)?.tag,
		tableColumnName: (table, column) =>
			scope.lookup === "unavailable"
				? undefined
				: scope.lookup.get(table)?.columns.find((value) => value.id === column)
						?.wireName,
		lookupInstancePrefix:
			context.profile.scope === "session" ? "item-list:" : "",
		locationLevelCode: (level) => organizationLevelsOf(scope.doc)[level]?.code,
		locationPropertySlug: (property) =>
			locationPropertiesOf(scope.doc)[property]?.slug,
		itextId: (unit) => itextIdFor(scope.doc, unit, form),
	};
}
