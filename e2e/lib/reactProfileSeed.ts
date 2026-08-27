/**
 * A deterministic Builder stress fixture shaped like the production app that
 * motivated the React performance pass. It keeps authored production content
 * out of the local database while preserving the dimensions that matter to
 * rendering and engine startup: four forms, 326 fields, and dense logic.
 */

import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, proseText, type Uuid } from "@/lib/domain";
import { buildUrl } from "@/lib/routing/location";

export const REACT_PROFILE_SEED = {
	appName: "React profile large app",
	moduleName: "Performance profile",
	formNames: [
		"Registration",
		"One group",
		"Random questions",
		"Adaptive question bank",
	],
	fieldCounts: [4, 94, 111, 117],
	targetHiddenId: "profile_target_hidden",
} as const;

interface KindCounts {
	hidden: number;
	text: number;
	int: number;
	single_select: number;
	date: number;
	label: number;
}

const LEAF_COUNTS_BY_FORM: readonly KindCounts[] = [
	{ hidden: 0, text: 3, int: 0, single_select: 0, date: 0, label: 0 },
	{ hidden: 34, text: 17, int: 15, single_select: 15, date: 7, label: 1 },
	{ hidden: 39, text: 20, int: 18, single_select: 18, date: 9, label: 1 },
	{ hidden: 41, text: 20, int: 19, single_select: 19, date: 10, label: 2 },
];

const GROUP_COUNTS = [0, 4, 5, 5] as const;

interface LogicCounters {
	calculate: number;
	defaultValue: number;
	relevant: number;
	validate: number;
	required: number;
	hint: number;
}

function nextLeaf(
	kind: keyof KindCounts,
	formIndex: number,
	ordinal: number,
	counters: LogicCounters,
	withCase: boolean,
): FieldSpec {
	const isTarget =
		kind === "hidden" &&
		formIndex === LEAF_COUNTS_BY_FORM.length - 1 &&
		ordinal === LEAF_COUNTS_BY_FORM[formIndex].hidden - 1;
	const id = isTarget
		? REACT_PROFILE_SEED.targetHiddenId
		: `profile_${kind}_${formIndex}_${ordinal}`;
	const uuid = `react-profile-${kind}-${formIndex}-${ordinal}`;

	if (kind === "hidden") {
		const value =
			counters.calculate < 102
				? { calculate: "1 + 1" }
				: { default_value: "'seed'" };
		if ("calculate" in value) counters.calculate++;
		else counters.defaultValue++;
		return f({
			kind,
			id,
			uuid,
			...value,
			...(counters.relevant++ < 192 && { relevant: "true()" }),
		});
	}
	if (kind === "label") {
		return f({
			kind,
			id,
			uuid,
			label: `Profile label ${formIndex + 1}.${ordinal + 1}`,
			...(counters.relevant++ < 192 && { relevant: "true()" }),
		});
	}

	const common = {
		kind,
		id,
		uuid,
		label: `Profile ${kind.replace("_", " ")} ${formIndex + 1}.${ordinal + 1}`,
		...(counters.relevant++ < 192 && { relevant: "true()" }),
		...(counters.hint++ < 64 && { hint: "A deterministic profiling hint" }),
		...(withCase && formIndex === 0 && kind === "text" && ordinal === 0
			? {
					caseWrite: {
						caseType: "profile_participant",
						property: "case_name",
					},
				}
			: {}),
	};
	return f({
		...common,
		...(counters.validate++ < 104 && {
			validate: "true()",
			validate_msg: "Keep this profiling answer valid",
		}),
		...(counters.required++ < 50 && { required: "true()" }),
		...(kind === "single_select" && {
			options: [
				{ label: "First option", value: "first" },
				{ label: "Second option", value: "second" },
			],
		}),
	});
}

function formFields(
	formIndex: number,
	counters: LogicCounters,
	withCase: boolean,
): FieldSpec[] {
	const leaves: FieldSpec[] = [];
	const counts = LEAF_COUNTS_BY_FORM[formIndex];
	for (const kind of [
		"text",
		"int",
		"single_select",
		"date",
		"label",
		"hidden",
	] as const) {
		for (let ordinal = 0; ordinal < counts[kind]; ordinal++) {
			leaves.push(nextLeaf(kind, formIndex, ordinal, counters, withCase));
		}
	}

	const groupCount = GROUP_COUNTS[formIndex];
	const grouped: FieldSpec[] = [];
	let cursor = 0;
	for (let group = 0; group < groupCount; group++) {
		const remainingLeaves = leaves.length - cursor;
		const remainingGroups = groupCount - group;
		const groupSize = Math.ceil(remainingLeaves / (remainingGroups + 1));
		grouped.push(
			f({
				kind: "group",
				id: `profile_group_${formIndex}_${group}`,
				uuid: `react-profile-group-${formIndex}-${group}`,
				label: `Question group ${group + 1}`,
				children: leaves.slice(cursor, cursor + groupSize),
			}),
		);
		cursor += groupSize;
	}
	grouped.push(...leaves.slice(cursor));

	return [
		f({
			kind: "section",
			id: `profile_section_${formIndex}`,
			uuid: `react-profile-section-${formIndex}`,
			label: `Profile section ${formIndex + 1}`,
			children: grouped,
		}),
	];
}

export interface ReactProfileBlueprint {
	doc: BlueprintDoc;
	moduleUuid: Uuid;
	initialFormUuid: Uuid;
	targetFormUuid: Uuid;
	targetFieldUuid: Uuid;
}

interface ReactProfileBlueprintOptions {
	readonly casePropertyCount?: number;
}

export function buildReactProfileBlueprint(
	appId = "react-profile-app",
	options: ReactProfileBlueprintOptions = {},
): ReactProfileBlueprint {
	const casePropertyCount = options.casePropertyCount ?? 94;
	if (
		!Number.isInteger(casePropertyCount) ||
		casePropertyCount < 0 ||
		casePropertyCount > 94
	) {
		throw new Error("React profile case-property count must be from 0 to 94.");
	}
	const counters: LogicCounters = {
		calculate: 0,
		defaultValue: 0,
		relevant: 0,
		validate: 0,
		required: 0,
		hint: 0,
	};
	const doc = buildDoc({
		appId,
		appName: REACT_PROFILE_SEED.appName,
		caseTypes:
			casePropertyCount === 0
				? null
				: [
						{
							name: "profile_participant",
							properties: Array.from(
								{ length: casePropertyCount },
								(_, index) => ({
									name: `profile_property_${index + 1}`,
									label: proseText(`Profile property ${index + 1}`),
									data_type: "text" as const,
								}),
							),
						},
					],
		modules: [
			{
				uuid: "react-profile-module",
				name: REACT_PROFILE_SEED.moduleName,
				...(casePropertyCount > 0 && { caseType: "profile_participant" }),
				...(casePropertyCount > 0 && {
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Participant" },
					]),
				}),
				forms: REACT_PROFILE_SEED.formNames.map((name, formIndex) => ({
					uuid: `react-profile-form-${formIndex}`,
					name,
					type:
						casePropertyCount === 0
							? ("survey" as const)
							: formIndex === 0
								? ("registration" as const)
								: ("followup" as const),
					fields: formFields(formIndex, counters, casePropertyCount > 0),
				})),
			},
		],
	});

	const moduleUuid = doc.moduleOrder[0];
	const formUuids = moduleUuid ? doc.formOrder[moduleUuid] : undefined;
	const initialFormUuid = formUuids?.[1];
	const targetFormUuid = formUuids?.[3];
	const targetField = Object.values(doc.fields).find(
		(field) => field.id === REACT_PROFILE_SEED.targetHiddenId,
	);
	if (
		moduleUuid === undefined ||
		initialFormUuid === undefined ||
		targetFormUuid === undefined ||
		targetField === undefined
	) {
		throw new Error(
			"React profile fixture did not build its target identities.",
		);
	}

	return {
		doc,
		moduleUuid,
		initialFormUuid,
		targetFormUuid,
		targetFieldUuid: targetField.uuid,
	};
}

export function reactProfileRoute(
	appId: string,
	fixture: Pick<
		ReactProfileBlueprint,
		"moduleUuid" | "targetFormUuid" | "targetFieldUuid"
	>,
): string {
	return buildUrl(`/build/${appId}`, {
		kind: "form",
		moduleUuid: fixture.moduleUuid,
		formUuid: fixture.targetFormUuid,
		selectedUuid: fixture.targetFieldUuid,
	});
}

export function reactProfileInitialRoute(
	appId: string,
	fixture: Pick<ReactProfileBlueprint, "moduleUuid" | "initialFormUuid">,
): string {
	return buildUrl(`/build/${appId}`, {
		kind: "form",
		moduleUuid: fixture.moduleUuid,
		formUuid: fixture.initialFormUuid,
	});
}
