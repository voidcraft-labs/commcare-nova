import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FieldSpec } from "@/lib/__tests__/docHelpers";
import type {
	BlueprintDoc,
	CaseType,
	Form,
	FormType,
	Module,
	Uuid,
} from "@/lib/domain";
import { caseSelectionCardinality } from "@/lib/domain";
import type { FormEngineInput } from "../../formEngine";

/** The test's authored field tree becomes one normalized app before source
 * expressions bind. Stable path-derived UUIDs keep runtime assertions readable. */
export function engineFixtureInput(
	fields: FieldSpec[],
	options: {
		formUuid: Uuid;
		formType: FormType;
		caseTypes?: CaseType[];
		caseType?: string;
		form?: Partial<Form>;
		module?: Partial<Module>;
		userProperties?: BlueprintDoc["userProperties"];
	},
): FormEngineInput {
	const withIds = (nodes: FieldSpec[], prefix: string): FieldSpec[] =>
		nodes.map((node) => ({
			...node,
			uuid: node.uuid ?? testUuid(`${prefix}.${node.id}`),
			...(node.children === undefined
				? {}
				: { children: withIds(node.children, `${prefix}.${node.id}`) }),
		}));
	const doc = buildDoc(
		{
			caseTypes: options.caseTypes ?? [],
			modules: [
				{
					name: "Runtime fixture",
					...(options.caseType === undefined
						? {}
						: { caseType: options.caseType }),
					forms: [
						{
							uuid: options.formUuid,
							id: "test-form",
							name: "Test Form",
							type: options.formType,
							fields: withIds(fields, "form"),
						},
					],
				},
			],
		},
		(candidate) => {
			candidate.forms[options.formUuid] = {
				...candidate.forms[options.formUuid],
				...options.form,
			};
			const moduleUuid = candidate.moduleOrder[0];
			candidate.modules[moduleUuid] = {
				...candidate.modules[moduleUuid],
				...options.module,
			};
			if (options.userProperties !== undefined) {
				candidate.userProperties = options.userProperties;
				candidate.userPropertyOrder = Object.values(options.userProperties).map(
					({ uuid }) => uuid,
				);
			}
		},
	);
	const form = doc.forms[options.formUuid];
	return {
		doc,
		form,
		formUuid: options.formUuid,
		fields: doc.fields,
		fieldOrder: doc.fieldOrder,
		caseTypes: doc.caseTypes ?? [],
		caseSelectionCardinality: caseSelectionCardinality(
			doc.modules[doc.moduleOrder[0]],
		),
		userProperties: doc.userProperties,
		searchInputs: doc.modules[doc.moduleOrder[0]].caseListConfig?.searchInputs,
	};
}
