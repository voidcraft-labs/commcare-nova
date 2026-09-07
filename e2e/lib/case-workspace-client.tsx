import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ColumnEditor } from "@/components/builder/case-list-config/ColumnEditor";
import { renderColumnCell } from "@/components/builder/case-list-config/columnCellRenderer";
import { Button } from "@/components/shadcn/button";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { evaluateCommit } from "@/lib/commcare/validator/gate";
import { columnSnapshotMutations } from "@/lib/doc/caseListColumnMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import {
	blueprintDocSchema,
	type CaseType,
	type Column,
	calculatedColumn,
	dateColumn,
	idMappingColumn,
	imageMapColumn,
	intervalColumn,
	linkColumn,
	phoneColumn,
	plainColumn,
	simpleSearchInputDef,
	tileCell,
	uuidSchema,
} from "@/lib/domain";
import {
	ancestorPath,
	double,
	prop,
	relationStep,
	term,
} from "@/lib/domain/predicate";
import { projectProseTemplate, proseText } from "@/lib/domain/prose";
import { BuilderSessionProvider } from "@/lib/session/provider";

const columnUuid = uuidSchema.parse("00000000-0000-7000-8000-000000004001");
const otherColumnUuid = uuidSchema.parse(
	"00000000-0000-7000-8000-000000004003",
);
const inputUuid = uuidSchema.parse("00000000-0000-7000-8000-000000004002");
const scenario = new URLSearchParams(location.search).get("scenario") ?? "date";
const caseTypes: CaseType[] = [
	{
		name: "patient",
		parent_type: "household",
		properties: [
			{ name: "case_name", label: proseText("Name"), data_type: "text" },
			{ name: "dob", label: proseText("Birth date"), data_type: "date" },
		],
	},
	{
		name: "household",
		properties: [
			{ name: "score", label: proseText("Score"), data_type: "int" },
		],
	},
];
const related = term(
	prop("patient", "score", ancestorPath(relationStep("parent", "household"))),
);
const slots = {
	sort: { direction: "asc" as const, priority: 0 },
	visibleInList: true,
	visibleInDetail: false,
	tile: tileCell(0, 0, 6, 1, { fontSize: "large", showBorder: true }),
};
if (scenario === "property-labels")
	caseTypes[0].properties.push(
		{ name: "local_score", label: proseText("Score"), data_type: "text" },
		{ name: "household_score", label: proseText("Score"), data_type: "text" },
		{ name: "risk_level", label: proseText("Risk"), data_type: "text" },
		{ name: "risk-level", label: proseText("Risk"), data_type: "text" },
		{ name: "external_id", label: proseText("external_id"), data_type: "text" },
		{ name: "date_opened", label: proseText("date_opened"), data_type: "date" },
	);
function initialColumn(): Column {
	switch (scenario) {
		case "property-labels":
			return plainColumn(columnUuid, "case_name", "", slots);
		case "interval":
			return intervalColumn(
				columnUuid,
				"dob",
				"Overdue",
				7,
				"days",
				"flag",
				"Late",
				slots,
			);
		case "interval-always":
			return intervalColumn(
				columnUuid,
				"dob",
				"Overdue",
				7,
				"days",
				"always",
				"Late",
				slots,
			);
		case "calculated":
		case "calculated-search":
			return calculatedColumn(columnUuid, "Household score", related, slots);
		case "retained-calculation":
			return calculatedColumn(
				columnUuid,
				"Household score",
				double(related),
				slots,
			);
		case "text":
			return plainColumn(columnUuid, "case_name", "Name", slots);
		case "phone":
			return phoneColumn(columnUuid, "case_name", "Phone", slots);
		case "link":
			return linkColumn(columnUuid, "case_name", "Website", "Open", slots);
		case "mapping":
			return idMappingColumn(
				columnUuid,
				"case_name",
				"Status",
				[
					{ value: "active", label: "Active" },
					{ value: "inactive", label: "Inactive" },
				],
				slots,
			);
		case "image-map":
			return imageMapColumn(columnUuid, "case_name", "Image", [], slots);
		default:
			return dateColumn(columnUuid, "dob", "Birthday", "%d-%m-%Y", slots);
	}
}
const column = initialColumn();
const config = caseListConfig([{ field: "case_name", header: "Name" }]);
config.columns = [column];
config.listColumnOrder = [columnUuid];
config.detailColumnOrder = [columnUuid];
if (scenario === "column-identity") {
	config.columns.push(
		plainColumn(otherColumnUuid, "dob", "Other birthday", {
			...slots,
			sort: { direction: "asc", priority: 1 },
			tile: tileCell(0, 2, 6, 1),
		}),
	);
	config.listColumnOrder.push(otherColumnUuid);
	config.detailColumnOrder.push(otherColumnUuid);
}
if (scenario === "calculated-search")
	config.searchInputs = [
		simpleSearchInputDef(inputUuid, "case_name", "Name", "text", "case_name"),
	];
const doc = buildDoc({
	caseTypes,
	modules: [
		{
			name: "Clients",
			caseType: "patient",
			caseListOnly: true,
			caseListConfig: config,
		},
	],
});
const verdict = evaluateCommit({
	nextDoc: structuredClone(doc),
	lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
});
if (!verdict.ok) throw new Error(JSON.stringify(verdict));
const persisted = toPersistableDoc(doc);
blueprintDocSchema.parse(persisted);
const moduleUuid = doc.moduleOrder[0];
function Fixture() {
	const module = useModule(moduleUuid),
		types = useCaseTypes();
	const mutations = useBlueprintMutations();
	const [selectedUuid, setSelectedUuid] = useState(columnUuid);
	const value = module?.caseListConfig?.columns.find(
		(c) => c.uuid === selectedUuid,
	);
	if (!module || !value) throw new Error("Missing module or column");
	if (scenario === "malformed-cell")
		return renderColumnCell(
			dateColumn(columnUuid, "dob", "Birth date", "%Y-%m-%d"),
			{
				case_id: "native-row",
				app_id: "native-case-column",
				case_type: "patient",
				case_name: "Example",
				owner_id: "native-owner",
				status: "open",
				opened_on: null,
				modified_on: null,
				closed_on: null,
				external_id: null,
				parent_case_id: null,
				properties: { dob: "not-a-date" },
				calculated: {},
			},
			{
				caseProperties: caseTypes[0].properties,
				calculatedTemporalTypes: new Map(),
				today: new Date("2026-07-17"),
				projectProse: (template) => projectProseTemplate(template, doc).text,
			},
		);
	return (
		<>
			<section
				aria-label="Column inspector"
				style={{ width: "min(100%, 360px)" }}
			>
				<ColumnEditor
					value={value}
					caseTypes={types}
					currentCaseType="patient"
					searchIsEffective={
						(module.caseListConfig?.searchInputs.length ?? 0) > 0
					}
					onChange={(next) => {
						const outcome = mutations.commitMany(
							columnSnapshotMutations(moduleUuid, value, next),
						);
						if (!outcome.ok) throw new Error("Column edit rejected");
					}}
				/>
			</section>
			<Button onClick={() => {}}>Leave inspector</Button>
			{scenario === "column-identity" ? (
				<Button onClick={() => setSelectedUuid(otherColumnUuid)}>
					Open other column
				</Button>
			) : null}
			<Button
				onClick={() => {
					const outcome = mutations.commitMany([
						{
							kind: "addSearchInput",
							moduleUuid,
							searchInput: simpleSearchInputDef(
								inputUuid,
								"case_name",
								"Name",
								"text",
								"case_name",
							),
						},
					]);
					if (!outcome.ok) throw new Error("Search edit rejected");
				}}
			>
				Peer enables Search
			</Button>
			<Button
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => {
					const outcome = mutations.commitMany(
						columnSnapshotMutations(moduleUuid, value, {
							...value,
							header: "Renamed by peer",
						}),
					);
					if (!outcome.ok) throw new Error("Peer header edit rejected");
				}}
			>
				Peer changes label
			</Button>

			<output aria-label="Saved column">{JSON.stringify(value)}</output>
			<output aria-label="Search enabled">
				{String((module.caseListConfig?.searchInputs.length ?? 0) > 0)}
			</output>
		</>
	);
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
	<BuilderSessionProvider
		init={{
			appId: "native-case-column",
			projectId: "native-project",
			role: "owner",
			canEdit: true,
		}}
	>
		<BlueprintDocProvider initialDoc={persisted} appId="native-case-column">
			<Fixture />
		</BlueprintDocProvider>
	</BuilderSessionProvider>,
);
