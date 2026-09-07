import { caseSearchCalculatedExpressionEditVerdict } from "@/lib/doc/hooks/predicateVerdicts";
import type { Column, ColumnKind } from "@/lib/domain";
import {
	calculatedColumn,
	dateColumn,
	idMappingColumn,
	imageMapColumn,
	intervalColumn,
	linkColumn,
	phoneColumn,
	plainColumn,
} from "@/lib/domain";
import { checkValueExpression, literal, term } from "@/lib/domain/predicate";
import { buildEditorTypeContext } from "../shared/editorTypeContext";
import {
	type ColumnEditContext,
	columnCardSchemas,
	resolveColumnProperty,
} from "./columnEditorSchemas";

/** Retained drafts belong to an open inspector; active presentation slots win. */
export function nextColumnDisplay(
	current: Column,
	target: ColumnKind,
	ctx: ColumnEditContext,
	drafts: ReadonlyMap<ColumnKind, Column>,
): Column | undefined {
	const draft = drafts.get(target);
	if (draft !== undefined) {
		const restored = restoreColumnDraft(draft, current);
		if (columnAdmittedForContext(restored, ctx)) return restored;
	}
	return preservedColumnSwap(current, target, ctx);
}

/**
 * Map a kind to the field-and-header-preserving rebuild for the
 * target kind. The seven non-calculated kinds carry `field: string`, so a
 * kind swap among them ALWAYS preserves the field verbatim, non-
 * twin transitions reset the kind-specific extras (date pattern,
 * threshold, mapping table) to the target schema's defaults.
 *
 * Calculated columns have no `field`. Swapping FROM calc into a
 * field-bearing kind seeds the new column's field via the target
 * schema's default-value factory; swapping TO calc drops the
 * field entirely. Header is preserved on every transition. The
 * column's `uuid` and optional common slots (`sort`, visibility,
 * and tile presentation) thread through verbatim: they're
 * identity / surface-presentation shape, not kind-specific.
 *
 * Exported as part of the module's tested surface: the
 * transformation is the contract (the emitted Column shape), so the
 * unit tests call it directly rather than driving the menu chrome.
 */
export function preservedColumnSwap(
	currentValue: Column,
	targetKind: ColumnKind,
	ctx: ColumnEditContext,
): Column | undefined {
	const { uuid, header } = currentValue;
	const slots = {
		sort: currentValue.sort,
		visibleInList: currentValue.visibleInList,
		visibleInDetail: currentValue.visibleInDetail,
		tile: currentValue.tile,
	};
	if (targetKind === "calculated") {
		// Twin: source is already calculated → preserve the
		// expression verbatim. Non-twin sources seed an empty-
		// string literal expression: the same shape the schema's
		// `defaultValue` factory uses, kept inline here so a kind
		// swap doesn't pull a fresh uuid via the factory.
		const expression =
			currentValue.kind === "calculated"
				? currentValue.expression
				: term(literal(""));
		return calculatedColumn(uuid, header, expression, slots);
	}

	const targetSchema = columnCardSchemas[targetKind];
	let targetField: string | undefined;
	if (currentValue.kind !== "calculated") {
		const sourceProperty = resolveColumnProperty(ctx, currentValue.field);
		if (
			sourceProperty === undefined ||
			!targetSchema.applicableForProperty(sourceProperty)
		) {
			return undefined;
		}
		targetField = currentValue.field;
	} else {
		targetField = targetSchema.defaultValue(ctx)?.field;
	}
	if (targetField === undefined) return undefined;

	switch (targetKind) {
		case "plain":
			return plainColumn(uuid, targetField, header, slots);
		case "phone":
			return phoneColumn(uuid, targetField, header, slots);
		case "link": {
			// Twin: source is already a link → preserve the author's own
			// link text. Otherwise seed it from the target schema, so the
			// default wording has exactly one home.
			const seed = columnCardSchemas.link.defaultValue(ctx);
			if (seed === undefined) return undefined;
			const linkText =
				currentValue.kind === "link" ? currentValue.linkText : seed.linkText;
			return linkColumn(uuid, targetField, header, linkText, slots);
		}
		case "date": {
			// Twin: source is already a date column → preserve the
			// pattern verbatim. Otherwise fall back to the target
			// schema's default pattern.
			const seed = columnCardSchemas.date.defaultValue(ctx);
			if (seed === undefined) return undefined;
			const pattern =
				currentValue.kind === "date" ? currentValue.pattern : seed.pattern;
			return dateColumn(uuid, targetField, header, pattern, slots);
		}
		case "id-mapping": {
			// Twin: source is already id-mapping → preserve the table.
			const mapping =
				currentValue.kind === "id-mapping" ? currentValue.mapping : [];
			return idMappingColumn(uuid, targetField, header, mapping, slots);
		}
		case "image-map": {
			// Twin: source is already image-map → preserve the value→image
			// table. id-mapping's table has incompatible entry shape
			// ({value,label} vs {value,assetId}), so a cross-kind swap
			// starts empty rather than mis-mapping labels onto images.
			const mapping =
				currentValue.kind === "image-map" ? currentValue.mapping : [];
			return imageMapColumn(uuid, targetField, header, mapping, slots);
		}
		case "interval": {
			// Twin: source is already interval → preserve every
			// kind-specific extra (threshold, unit, display, text).
			// Non-twin sources seed the extras from the target schema's
			// default factory.
			const seed = columnCardSchemas.interval.defaultValue(ctx);
			if (seed === undefined) return undefined;
			if (currentValue.kind === "interval") {
				return intervalColumn(
					uuid,
					currentValue.field,
					header,
					currentValue.threshold,
					currentValue.unit,
					currentValue.display,
					currentValue.text,
					slots,
				);
			}
			return intervalColumn(
				uuid,
				targetField,
				header,
				seed.threshold,
				seed.unit,
				seed.display,
				seed.text,
				slots,
			);
		}
		default: {
			// `undefined` is a real answer here -- it means "this display
			// does not fit this property" -- so a missing arm would fall
			// out as a silent no-op: the menu offers the display, the
			// author picks it, and nothing changes. Naming the remainder
			// makes a new column kind a type error instead.
			const unhandled: never = targetKind;
			return unhandled;
		}
	}
}

/** Common slots follow the active display while a locally retained kind draft
 * restores only that kind's source and formatting. */
export function restoreColumnDraft(draft: Column, current: Column): Column {
	return {
		...draft,
		uuid: current.uuid,
		header: current.header,
		sort: current.sort,
		visibleInList: current.visibleInList,
		visibleInDetail: current.visibleInDetail,
		tile: current.tile,
	} as Column;
}

/** A retained display draft is reusable only while its source still exists
 * and remains compatible with that display kind. */
export function columnAdmittedForContext(
	column: Column,
	ctx: ColumnEditContext,
): boolean {
	if (column.kind === "calculated") {
		const typeContext = buildEditorTypeContext({ ...ctx, knownInputs: [] });
		return (
			checkValueExpression(column.expression, typeContext).ok &&
			(!ctx.searchIsEffective ||
				caseSearchCalculatedExpressionEditVerdict(
					column.expression,
					typeContext,
				).ok)
		);
	}
	const property = resolveColumnProperty(ctx, column.field);
	return (
		property !== undefined &&
		columnCardSchemas[column.kind].applicableForProperty(property)
	);
}

/** Explain only changes that discard meaningful authored work. Ordinary
 * presentation changes stay one click; custom mappings, calculations, and
 * tuned formats receive a truthful consequence before replacement. */
export function columnKindChangeConsequence(
	current: Column,
	targetKind: ColumnKind,
	ctx: ColumnEditContext,
): string | null {
	if (current.kind === targetKind) return null;
	if (targetKind === "calculated" && current.kind !== "calculated") {
		return "The current information source will be replaced with a new calculation";
	}
	switch (current.kind) {
		case "plain":
		case "phone":
			return null;
		case "link":
			// The link text is the only thing a link column carries that no
			// other kind does, and losing a word is not worth a warning.
			return null;
		case "date": {
			const seed = columnCardSchemas.date.defaultValue(ctx);
			if (seed === undefined) return null;
			return current.pattern === seed.pattern
				? null
				: "The custom date format will be removed";
		}
		case "id-mapping":
			return current.mapping.length === 0
				? null
				: "The friendly value labels will be removed";
		case "image-map":
			return current.mapping.length === 0
				? null
				: "The value images will be removed";
		case "interval": {
			const seed = columnCardSchemas.interval.defaultValue(ctx);
			if (seed === undefined) return null;
			const customized =
				current.threshold !== seed.threshold ||
				current.unit !== seed.unit ||
				current.display !== seed.display ||
				current.text !== seed.text;
			return customized ? "The time range settings will be removed" : null;
		}
		case "calculated": {
			const seed = columnCardSchemas.calculated.defaultValue(ctx);
			if (seed === undefined) return null;
			return JSON.stringify(current.expression) ===
				JSON.stringify(seed.expression)
				? null
				: "The calculation will be replaced with saved case information";
		}
	}
}
