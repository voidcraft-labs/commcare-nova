/** The documents the case list and search readers' tests read back: one menu of patients, a
 *  registration form that writes the properties its columns show, and the list given. */
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { Column, SearchInputDef, Uuid } from "@/lib/domain";
import type { CaseListConfig, CaseSearchConfig } from "@/lib/domain/modules";

export const uuid = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as Uuid;

export function patients(
	columns: Column[],
	options: {
		readonly listOrder?: Uuid[];
		readonly detailOrder?: Uuid[];
		readonly searchInputs?: SearchInputDef[];
		readonly search?: CaseSearchConfig;
		readonly list?: Partial<
			Pick<
				CaseListConfig,
				"filter" | "searchCondition" | "searchFilters" | "tile" | "selection"
			>
		>;
	} = {},
) {
	return buildDoc({
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "text",
								id: "notes",
								caseWrite: { caseType: "patient", property: "notes" },
							}),
							f({
								kind: "date",
								id: "dob",
								caseWrite: { caseType: "patient", property: "dob" },
							}),
							f({
								kind: "text",
								id: "phone",
								caseWrite: { caseType: "patient", property: "phone" },
							}),
						],
					},
				],
				caseListConfig: {
					columns,
					searchInputs: options.searchInputs ?? [],
					...options.list,
					...(options.listOrder !== undefined && {
						listColumnOrder: options.listOrder,
					}),
					...(options.detailOrder !== undefined && {
						detailColumnOrder: options.detailOrder,
					}),
				},
				...(options.search !== undefined && {
					caseSearchConfig: options.search,
				}),
			},
		],
	});
}
