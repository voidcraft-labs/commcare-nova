import { z } from "zod";
import { valueSchema } from "./expression/types";
import type { Module } from "./modules";
import { type Uuid, uuidSchema } from "./uuid";

export const caseFormContextSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("menu-tile"),
		moduleUuid: uuidSchema,
		expression: valueSchema.optional(),
		expandDetails: z.literal(true).optional(),
	}),
	z.strictObject({
		kind: z.literal("own-tile"),
		expandDetails: z.literal(true),
	}),
	z.strictObject({ kind: z.literal("line"), expression: valueSchema }),
]);

export type CaseFormContext = z.infer<typeof caseFormContextSchema>;

export function caseContextLine(context: CaseFormContext | undefined) {
	return context && "expression" in context ? context.expression : undefined;
}

export interface ResolvedCaseFormContext {
	sourceModuleUuid: Uuid;
	kind: "tile" | "line";
	inlineModuleUuid?: Uuid;
}

/** A form never chooses another case to display its context. The selected
 * case is displayed using a reachable source menu's layout or its own line. */
export function resolveCaseFormContext(
	modules: Readonly<Record<string, Module | undefined>>,
	menuUuid: Uuid,
): ResolvedCaseFormContext | undefined {
	const local = modules[menuUuid];
	const config = local?.caseListConfig;
	if (!local || !config) return;
	const context = config.contextAboveForm;
	const requested =
		context?.kind === "menu-tile" ? modules[context.moduleUuid] : undefined;
	const external =
		requested?.caseListConfig?.tile && requested.caseType === local.caseType
			? requested
			: undefined;
	const own = config.tile?.persistOnForms === true ? local : undefined;
	const source = external ?? own;
	if (!source)
		return caseContextLine(context)
			? { kind: "line", sourceModuleUuid: local.uuid }
			: undefined;
	const expand = context?.kind !== "line" && context?.expandDetails;
	const details =
		expand &&
		[source, own].find((candidate) =>
			candidate?.caseListConfig?.columns.some(
				(column) => column.visibleInDetail !== false,
			),
		);
	return {
		kind: "tile",
		sourceModuleUuid: source.uuid,
		...(details && { inlineModuleUuid: details.uuid }),
	};
}

/** The author's single choice includes the ordinary, non-expanding tile that
 * predates independent context (stored by its existing Results setting). */
export const caseFormContextChoiceSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("own-tile"),
		expandDetails: z.literal(true).optional(),
	}),
	caseFormContextSchema.options[0],
	caseFormContextSchema.options[2],
]);
export type CaseFormContextChoice = z.infer<typeof caseFormContextChoiceSchema>;

export function presentFormContext(
	config: NonNullable<Module["caseListConfig"]>,
): CaseFormContextChoice | null {
	return (
		config.contextAboveForm ??
		(config.tile?.persistOnForms ? { kind: "own-tile" } : null)
	);
}

/** Switch the tile and the independent context together so the old setting
 * cannot shadow a newly authored line. An external tile keeps a previous
 * local tile as a fallback unless the author supplies a fallback line. */
export function formContextPatch(
	config: NonNullable<Module["caseListConfig"]>,
	choice: CaseFormContextChoice | null,
) {
	const own = choice?.kind === "own-tile";
	if (own && !config.tile)
		return {
			error:
				"Lay out this menu’s Results as a tile before keeping it above a form.",
		} as const;
	const persist =
		own ||
		(choice?.kind === "menu-tile" &&
			!choice.expression &&
			config.tile?.persistOnForms === true);
	const contextAboveForm =
		choice?.kind === "own-tile"
			? choice.expandDetails
				? ({ kind: "own-tile", expandDetails: true } as const)
				: null
			: choice;
	const tile = config.tile;
	if (!tile || Boolean(tile.persistOnForms) === persist)
		return { patch: { contextAboveForm } } as const;
	const { persistOnForms: previous, ...rest } = tile;
	return {
		patch: {
			contextAboveForm,
			tile: persist ? { ...rest, persistOnForms: true as const } : rest,
		},
	} as const;
}
