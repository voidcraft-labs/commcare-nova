/** Worker wording belonging to one output of a control. The output identity
 * stays with the control even when several controls use the same starting text. */

import { caseTypesWithRelations } from "./appCaseRelations";
import type { BlueprintDoc } from "./blueprint";
import {
	type CaseMappingRow,
	caseMappingRowUuid,
	caseMappingTextUnit,
} from "./caseMappingRows";
import { columnPropertyCaseType } from "./columnRelation";
import { makeTranslationUnitId, type TranslationUnitId } from "./localization";
import {
	CASE_LIST_EMPTY_TEXT_DEFAULT,
	CASE_LIST_SELECT_TEXT_DEFAULT,
	CASE_SEARCH_BUTTON_LABEL,
	columnSortLabelShows,
	DEFAULT_CASE_SEARCH_TITLE,
	effectiveCaseSearchConfig,
	moduleHasCaseListMenuItem,
} from "./modules";
import { projectProseTemplate } from "./prose";
import {
	caseListWordingUnitId,
	type TranslationUnit,
	type TranslationUnitOwner,
} from "./translationUnits";
import type { Uuid } from "./uuid";

export const generatedWordingRoles = {
	caseRows: "Case list wording",
	caseDetails: "Case detail wording",
	searchRows: "Search results wording",
	searchDetails: "Search result detail wording",
	registrationMenuTitle: "Registration menu title",
	caseTitle: "Case details title",
	menuTitle: "Menu title",
	formTitle: "Form menu label",
	submitButton: "Submit button",
	caseListEntry: "Case list menu label",
	registerButton: "Registration button",
	selectCase: "Case selection button",
	emptyList: "Empty case list",
	searchButton: "Search button",
	searchTitle: "Search screen title",
	searchDescription: "Search screen description",
	promptLabel: "Search field label",
	promptHint: "Search field hint",
	promptRequired: "Search field required message",
	promptValidation: "Search field check message",
} as const;
export type GeneratedWordingRole = keyof typeof generatedWordingRoles;

export interface GeneratedWording {
	readonly role: GeneratedWordingRole;
	readonly base?: TranslationUnitId;
	/** This owner still exists, but its current configuration omits this output. */
	readonly dormant?: true;
}

export function generatedWordingId(
	owner: string,
	role: GeneratedWordingRole,
	...slot: string[]
): TranslationUnitId {
	return makeTranslationUnitId("generated", owner, role, ...slot);
}

/** One view's own description of an image rule. A saved-value row from before
 * row identities is addressed by its value, every other row by its UUID, as
 * its ordinary description unit is (`caseMappingTextUnit`). */
export function imageDescriptionWordingId(
	columnUuid: Uuid,
	role: GeneratedWordingRole,
	row: CaseMappingRow,
): TranslationUnitId {
	return generatedWordingId(
		columnUuid,
		role,
		"image-description",
		...imageDescriptionSlot(columnUuid, row),
	);
}

function imageDescriptionSlot(columnUuid: Uuid, row: CaseMappingRow) {
	return row.uuid === undefined && !row.when
		? [row.value ?? ""]
		: ["row", caseMappingRowUuid(columnUuid, row)];
}

export function columnWordingRole(
	search: boolean,
	detail: boolean,
): GeneratedWordingRole {
	return search
		? detail
			? "searchDetails"
			: "searchRows"
		: detail
			? "caseDetails"
			: "caseRows";
}

type WordingUnit = Omit<TranslationUnit, "sourceFingerprint" | "contentPolicy">;

/** Inventory the independently configurable outputs at their owning controls.
 * A missing override follows its ordinary slot in the selected language. */
export function generatedWordingUnits(
	doc: BlueprintDoc,
	ordinary: readonly TranslationUnit[],
): WordingUnit[] {
	const all = new Map(ordinary.map((unit) => [unit.id, unit]));
	const byColumn = new Map<string, TranslationUnit[]>();
	const byProperty = new Map<string, TranslationUnit[]>();
	for (const unit of all.values()) {
		const owner = unit.owner;
		const lookup =
			owner.kind === "case-list-column"
				? byColumn
				: owner.kind === "case-property-option"
					? byProperty
					: undefined;
		if (!lookup) continue;
		const key =
			owner.kind === "case-list-column"
				? owner.columnUuid
				: owner.kind === "case-property-option"
					? makeTranslationUnitId(owner.caseType, owner.property)
					: "";
		const list = lookup.get(key);
		if (list) list.push(unit);
		else lookup.set(key, [unit]);
	}
	const out: WordingUnit[] = [];
	const add = (
		dormant: boolean,
		owner: TranslationUnitOwner,
		id: string,
		role: GeneratedWordingRole,
		breadcrumb: readonly string[],
		source: string,
		base?: TranslationUnitId,
		...slot: string[]
	) => {
		const unitId = generatedWordingId(id, role, ...slot);
		out.push({
			id: unitId,
			role: "generated-wording",
			owner,
			valueKind: "text",
			source,
			breadcrumb: [...breadcrumb, generatedWordingRoles[role]],
			context: {},
			generated: {
				role,
				...(base && { base }),
				...(dormant && { dormant: true }),
			},
		});
	};
	const app = { kind: "app" } as const;
	let relationTypes: ReturnType<typeof caseTypesWithRelations> | undefined;

	add(false, app, "app", "caseTitle", [doc.appName], "Case");
	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		if (!mod) continue;
		const owner = { kind: "module", moduleUuid } as const;
		const path = [doc.appName, mod.name];
		const name = makeTranslationUnitId("module", moduleUuid, "name");
		add(false, owner, moduleUuid, "menuTitle", path, mod.name, name);
		const search = effectiveCaseSearchConfig(mod);
		const noCases = !mod.caseListConfig && !mod.caseType;
		// A list's own text is the default its per-output wording follows.
		const ownText = mod.caseListConfig;
		add(
			noCases,
			owner,
			moduleUuid,
			"selectCase",
			path,
			ownText?.selectButtonText ?? CASE_LIST_SELECT_TEXT_DEFAULT,
			ownText?.selectButtonText === undefined
				? undefined
				: caseListWordingUnitId(moduleUuid, "select"),
		);
		add(
			noCases,
			owner,
			moduleUuid,
			"emptyList",
			path,
			ownText?.emptyText ?? CASE_LIST_EMPTY_TEXT_DEFAULT,
			ownText?.emptyText === undefined
				? undefined
				: caseListWordingUnitId(moduleUuid, "empty"),
		);
		{
			const slot =
				mod.caseListMenuItem?.label === undefined
					? name
					: makeTranslationUnitId(
							"module",
							moduleUuid,
							"case-list-menu-item-label",
						);
			add(
				!moduleHasCaseListMenuItem(mod),
				owner,
				moduleUuid,
				"caseListEntry",
				path,
				mod.caseListMenuItem?.label ?? mod.name,
				slot,
			);
		}
		const registration = mod.caseListRegistrationForm;
		{
			const base = !registration
				? undefined
				: registration.label === undefined
					? makeTranslationUnitId("form", registration.formUuid, "name")
					: makeTranslationUnitId(
							"module",
							moduleUuid,
							"case-list-registration-label",
						);
			add(
				!registration,
				owner,
				moduleUuid,
				"registerButton",
				path,
				registration?.label ??
					(registration && doc.forms[registration.formUuid]?.name) ??
					"",
				base,
			);
		}
		for (const column of mod.caseListConfig?.columns ?? []) {
			const own = {
				kind: "case-list-column",
				moduleUuid,
				columnUuid: column.uuid,
			} as const;
			if (column.kind === "plain" && column.via !== undefined)
				relationTypes ??= caseTypesWithRelations(doc);
			const propertyType =
				column.kind === "plain"
					? columnPropertyCaseType(
							column,
							mod.caseType,
							column.via === undefined
								? (doc.caseTypes ?? [])
								: (relationTypes ?? []),
						)
					: undefined;
			if (column.kind === "image-map") {
				for (const entry of column.mapping) {
					for (const searchView of [false, true]) {
						for (const detail of [false, true]) {
							const dormant =
								(searchView && (!search || search.formsReadSearch === true)) ||
								(detail
									? column.visibleInDetail === false
									: column.visibleInList === false);
							add(
								dormant,
								own,
								column.uuid,
								columnWordingRole(searchView, detail),
								[
									...path,
									column.header,
									entry.value ?? entry.altText ?? "",
									"Image description",
								],
								entry.altText ?? "",
								entry.altText === undefined
									? undefined
									: caseMappingTextUnit(
											column.uuid,
											entry,
											"image-description",
										),
								"image-description",
								...imageDescriptionSlot(column.uuid, entry),
							);
						}
					}
				}
			}
			const slots = [
				...(byColumn.get(column.uuid) ?? []),
				...(column.kind === "plain" && propertyType !== undefined
					? (byProperty.get(
							makeTranslationUnitId(propertyType, column.field),
						) ?? [])
					: []),
			];
			for (const base of slots) {
				const source =
					typeof base.source === "string"
						? base.source
						: projectProseTemplate(base.source, doc).text;
				const sort = base.role === "case-list-sort-label";
				for (const searchView of [false, true]) {
					for (const detail of sort ? [false] : [false, true]) {
						const role = columnWordingRole(searchView, detail);
						const dormant =
							(searchView && (!search || search.formsReadSearch === true)) ||
							(sort
								? !columnSortLabelShows(column)
								: detail
									? column.visibleInDetail === false
									: column.visibleInList === false);
						add(
							dormant,
							own,
							column.uuid,
							role,
							[...path, column.header, base.breadcrumb.at(-1) ?? column.header],
							source,
							base.id,
							base.id,
						);
					}
				}
			}
		}
		add(
			!search,
			owner,
			moduleUuid,
			"searchButton",
			path,
			CASE_SEARCH_BUTTON_LABEL,
		);
		for (const [role, slot] of [
			["searchTitle", "search-title"],
			["searchDescription", "search-subtitle"],
		] as const) {
			const id = makeTranslationUnitId("module", moduleUuid, slot);
			const original = all.get(id);
			add(
				!search || !original,
				owner,
				moduleUuid,
				role,
				path,
				typeof original?.source === "string"
					? original.source
					: role === "searchTitle"
						? DEFAULT_CASE_SEARCH_TITLE
						: "",
				id,
			);
		}
		for (const input of mod.caseListConfig?.searchInputs ?? []) {
			const hidden = !search || input.kind === "hidden";
			const field = {
				kind: "search-input",
				moduleUuid,
				searchInputUuid: input.uuid,
			} as const;
			const fieldPath = [...path, input.label];
			// Every visible input can gain or lose a generated search check
			// as its filter changes. Its own wording stays with the input.
			add(hidden, field, input.uuid, "promptValidation", fieldPath, "");
			for (const [role, slot] of [
				["promptLabel", "label"],
				["promptHint", "hint"],
				["promptRequired", "required-message"],
			] as const) {
				const id = makeTranslationUnitId("search-input", input.uuid, slot);
				const base =
					slot === "required-message" &&
					input.kind !== "hidden" &&
					input.required &&
					input.required.message === undefined
						? makeTranslationUnitId("system", "search-required", "default")
						: id;
				const original = all.get(base);

				add(
					hidden || !original,
					field,
					input.uuid,
					role,
					fieldPath,
					typeof original?.source === "string" ? original.source : "",
					base,
				);
			}
		}
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (!form) continue;
			const formOwner = { kind: "form", moduleUuid, formUuid } as const;
			const formPath = [...path, form.name];
			add(
				registration?.kind !== "after-empty-search" ||
					registration.formUuid !== formUuid,
				formOwner,
				formUuid,
				"registrationMenuTitle",
				formPath,
				form.name,
				makeTranslationUnitId("form", formUuid, "name"),
			);
			add(
				false,
				formOwner,
				formUuid,
				"formTitle",
				formPath,
				form.name,
				makeTranslationUnitId("form", formUuid, "name"),
			);
			add(false, formOwner, formUuid, "submitButton", formPath, "Submit");
		}
	}
	return out;
}
