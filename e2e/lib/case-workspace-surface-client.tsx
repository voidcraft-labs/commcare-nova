import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
	CaseListWorkspaceCanvas,
	CaseListWorkspaceControllerBridge,
} from "@/components/builder/case-list-config/CaseListConfigWorkspace";
import {
	CaseListWorkspaceProvider,
	useCaseListInspector,
} from "@/components/builder/case-list-config/CaseListWorkspaceProvider";
import { Button } from "@/components/shadcn/button";
import { buildDoc, caseListConfig, xp } from "@/lib/__tests__/docHelpers";
import { evaluateCommit } from "@/lib/commcare/validator/gate";
import { columnSnapshotMutations } from "@/lib/doc/caseListColumnMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import {
	advancedSearchInputDef,
	blueprintDocSchema,
	type CaseType,
	plainColumn,
	simpleSearchInputDef,
	tileCell,
	uuidSchema,
} from "@/lib/domain";
import {
	and,
	dateLiteral,
	eq,
	input,
	literal,
	lt,
	prop,
	sessionContext,
	term,
	today,
	whenInput,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { invalidateCaseData } from "@/lib/preview/hooks/caseDataInvalidation";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";
import {
	BuilderSessionProvider,
	useBuilderSession,
} from "@/lib/session/provider";

const scenario =
	new URLSearchParams(location.search).get("scenario") ?? "results";
const appId = "native-workspace";
const nameId = uuidSchema.parse("00000000-0000-7000-8000-000000006001"),
	dobId = uuidSchema.parse("00000000-0000-7000-8000-000000006002"),
	searchId = uuidSchema.parse("00000000-0000-7000-8000-000000006003");
const siblingId = uuidSchema.parse("00000000-0000-7000-8000-000000006004");
const caseTypes: CaseType[] = [
	{
		name: "patient",
		properties: [
			{ name: "case_name", label: proseText("Client name"), data_type: "text" },
			{ name: "dob", label: proseText("Birth date"), data_type: "date" },
			{ name: "region", label: proseText("Region"), data_type: "text" },
			{ name: "stage", label: proseText("Status"), data_type: "text" },
			{ name: "photo_url", label: proseText("Photo"), data_type: "text" },
		],
	},
];
const config = caseListConfig([{ field: "case_name", header: "Name" }]);
config.columns = [
	plainColumn(nameId, "case_name", "Client name"),
	plainColumn(dobId, "dob", "Birth date"),
];
config.listColumnOrder = [nameId, dobId];
config.detailColumnOrder = [dobId, nameId];
if (scenario.startsWith("search"))
	config.searchInputs = [
		simpleSearchInputDef(searchId, "name", "Name", "text", "case_name"),
	];
if (scenario === "search-date")
	config.searchInputs = [
		simpleSearchInputDef(searchId, "dob", "Birth date", "date", "dob", {
			default: today(),
		}),
	];
if (scenario === "search-text")
	config.searchInputs = [
		simpleSearchInputDef(searchId, "name", "Name", "text", "case_name", {
			mode: { kind: "exact" },
			default: term(literal("Maya")),
		}),
	];
if (scenario === "search-clone")
	config.searchInputs = [
		advancedSearchInputDef(
			searchId,
			"name",
			"Name",
			"text",
			and(
				lt(prop("patient", "dob"), dateLiteral("2026-01-01")),
				eq(prop("patient", "region"), literal("North")),
			),
		),
	];
if (scenario === "search-dependencies") {
	const dependency = whenInput(
		input(searchId),
		eq(prop("patient", "case_name"), input(searchId)),
	);
	config.filter = dependency;
	config.searchInputs?.push(
		advancedSearchInputDef(siblingId, "region", "Region", "text", dependency),
	);
}
if (scenario === "selection" || scenario === "selection-viewer") {
	config.tile = { persistOnForms: true };
	config.columns = config.columns.map((c, i) => ({
		...c,
		tile: tileCell(0, i, 12, 1),
	}));
}
if (scenario === "selection-viewer") {
	config.selection = { kind: "multiple", maximum: 8 };
	config.tile = {};
}
if (scenario.startsWith("filter"))
	config.filter = eq(prop("patient", "region"), literal("North"));
const source = buildDoc({
	appName: "Native case workspace",
	caseTypes,
	modules: [
		{
			name: "Clients",
			caseType: "patient",
			caseListConfig: config,
			...(scenario.startsWith("search") || scenario.startsWith("filter")
				? {
						caseSearchConfig:
							scenario === "search-remove" || scenario === "filter-owner"
								? {
										...(scenario === "search-remove"
											? { searchScreenTitle: "Find a client" }
											: {}),
										searchButtonLabel: "Find",
										excludedOwnerIds: term(sessionContext("userid")),
									}
								: {},
					}
				: {}),
			forms: [
				{
					name: "Visit",
					type: "followup",
					fields: [
						{
							kind: "text",
							id: "stage",
							label: proseText("Status"),
							default_value: xp("'pending'"),
							caseWrite: { caseType: "patient", property: "stage" },
						},
						{
							kind: "image",
							id: "photo",
							label: proseText("Photo"),
							caseWrite: {
								caseType: "patient",
								property: "photo_url",
								mode: "url",
							},
						},
					],
				},
			],
		},
	],
});
const gate = evaluateCommit({
	nextDoc: structuredClone(source),
	lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
});
if (!gate.ok) throw new Error(JSON.stringify(gate));
const persisted = toPersistableDoc(source);
blueprintDocSchema.parse(persisted);
const moduleUuid = source.moduleOrder[0];
pushBuilderHistory(
	`/build/${appId}/${moduleUuid}/${scenario.startsWith("search") ? "search" : "results"}`,
	true,
);

function Surface() {
	const module = useModule(moduleUuid);
	const inspector = useCaseListInspector();
	const mutations = useBlueprintMutations();
	const beginAccessRefresh = useBuilderSession((s) => s.beginAccessRefresh);
	const applyAccessSnapshot = useBuilderSession((s) => s.applyAccessSnapshot);
	useEffect(() => {
		const peer = () => {
			const field = Object.values(source.fields).find((f) => f.id === "stage");
			if (!field) throw new Error("Missing peer field");
			const outcome = mutations.updateField(field.uuid, "text", {
				label: proseText("Peer status"),
			});
			if (!outcome.ok) throw new Error("Peer field refused");
		};
		window.addEventListener("native-peer-selection", peer);
		return () => window.removeEventListener("native-peer-selection", peer);
	}, [mutations]);
	if (!module?.caseListConfig) throw new Error("Missing workspace module");
	return (
		<>
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "minmax(0, 1fr) 340px",
					gap: 20,
					height: 620,
					minWidth: 0,
				}}
			>
				<section
					aria-label="Case workspace"
					style={{ minWidth: 0, minHeight: 0 }}
				>
					<CaseListWorkspaceCanvas />
				</section>
				<aside
					aria-label="Workspace properties"
					data-case-workspace-inspector
					style={{ overflowY: "auto", minWidth: 0 }}
				>
					{inspector?.inspector ? (
						<>
							<h2 data-builder-secondary-header="inspector">
								{inspector.inspector.title}
							</h2>
							<Button onClick={inspector.onClose}>Close properties</Button>
							{inspector.inspector.body}
						</>
					) : null}
				</aside>
			</div>
			<Button
				onMouseDown={(e) => e.preventDefault()}
				onClick={() => {
					const current = module.caseListConfig?.columns[0];
					if (!current) return;
					const result = mutations.commitMany(
						columnSnapshotMutations(moduleUuid, current, {
							...current,
							header: "Peer label",
						}),
					);
					if (!result.ok) throw new Error("Peer label failed");
				}}
			>
				Peer changes label
			</Button>
			<Button
				onMouseDown={(e) => e.preventDefault()}
				onClick={() => {
					const result = mutations.commitMany([
						{
							kind: "setCaseListMeta",
							uuid: moduleUuid,
							patch: { selection: { kind: "multiple", maximum: 18 } },
						},
					]);
					if (!result.ok) throw new Error("Peer limit failed");
				}}
			>
				Peer changes limit
			</Button>

			<Button onClick={() => invalidateCaseData(appId, "patient")}>
				Case data changed
			</Button>
			<Button onClick={() => invalidateCaseData(appId, "household")}>
				Other case data changed
			</Button>
			<Button onClick={() => beginAccessRefresh()}>Refresh access</Button>
			<Button
				onClick={() =>
					applyAccessSnapshot({
						projectId: "native-project",
						role: "owner",
						canEdit: true,
					})
				}
			>
				Access confirmed
			</Button>
			<Button
				onClick={() => {
					const result = mutations.commitMany([
						{
							kind: "setCaseListMeta",
							uuid: moduleUuid,
							patch: {
								filter: eq(prop("patient", "region"), literal("South")),
							},
						},
					]);
					if (!result.ok) throw new Error("Peer filter failed");
				}}
			>
				Peer changes filter
			</Button>
			<Button
				onClick={() => {
					const result = mutations.commitMany([
						{
							kind: "setCaseListMeta",
							uuid: moduleUuid,
							patch: {
								filter: whenInput(
									input(searchId),
									eq(prop("patient", "case_name"), literal("North")),
								),
							},
						},
					]);
					if (!result.ok) throw new Error("Peer dependency failed");
				}}
			>
				Peer simplifies dependency
			</Button>
			<Button
				onClick={() => {
					const result = mutations.commitMany([
						{
							kind: "setCaseListMeta",
							uuid: moduleUuid,
							patch: { filter: null },
						},
						{
							kind: "updateSearchInput",
							moduleUuid,
							uuid: siblingId,
							searchInput: {
								kind: "advanced",
								name: "region",
								label: "Region",
								type: "text",
								predicate: eq(prop("patient", "region"), literal("North")),
							},
						},
					]);
					if (!result.ok) throw new Error("Peer dependency cleanup failed");
				}}
			>
				Peer clears dependencies
			</Button>
			<Button onClick={() => {}}>Leave workspace</Button>
			<output aria-label="Saved module" style={{ display: "none" }}>
				{JSON.stringify(module)}
			</output>
		</>
	);
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
root.style.maxWidth = "1240px";
createRoot(root).render(
	<BuilderSessionProvider
		init={{
			appId,
			projectId: "native-project",
			role: "owner",
			canEdit: scenario !== "selection-viewer",
		}}
	>
		<BlueprintDocProvider
			initialDoc={persisted}
			appId={appId}
			canEdit={scenario !== "selection-viewer"}
		>
			<CaseListWorkspaceProvider
				controllerComponent={CaseListWorkspaceControllerBridge}
			>
				<Surface />
			</CaseListWorkspaceProvider>
		</BlueprintDocProvider>
	</BuilderSessionProvider>,
);
