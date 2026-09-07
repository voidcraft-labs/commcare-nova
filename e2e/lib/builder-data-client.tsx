import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { CaseDataManager } from "@/components/builder/CaseDataManager";
import { ToastContainer } from "@/components/ui/ToastContainer";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { evaluateCommit } from "@/lib/commcare/validator/gate";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { blueprintDocSchema } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";
import {
	BuilderSessionProvider,
	useBuilderSessionApi,
} from "@/lib/session/provider";

const scenario =
	new URLSearchParams(location.search).get("scenario") ?? "empty";
const canEdit = scenario !== "viewer";
const appId = "native-case-data";
const source = buildDoc({
	appName: "Native case data",
	caseTypes: [
		{
			name: "patient",
			properties: [{ name: "case_name", label: proseText("Name") }],
		},
		{ name: "visit", parent_type: "patient", properties: [] },
	],
	modules: [
		{
			name: "Patients",
			caseType: "patient",
			caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
			forms: [
				{
					name: "Register patient",
					type: "registration",
					fields: [
						f({
							kind: "text",
							id: "case_name",
							label: proseText("Name"),
							caseWrite: { caseType: "patient", property: "case_name" },
						}),
					],
				},
			],
		},
	],
});
source.appId = appId;
const persisted = blueprintDocSchema.parse(
	JSON.parse(JSON.stringify(toPersistableDoc(source))),
);
const admitted = evaluateCommit({
	nextDoc: source,
	lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
});
if (!admitted.ok) throw new Error(JSON.stringify(admitted.findings));
const moduleUuid = source.moduleOrder[0];
if (!moduleUuid || !source.caseTypes)
	throw new Error("Missing fixture vocabulary");
const caseTypes = source.caseTypes;
pushBuilderHistory(`/a/${appId}/m/${moduleUuid}/results`);
function Surface() {
	const session = useBuilderSessionApi();
	useEffect(() => {
		const refresh = () => session.getState().beginAccessRefresh();
		window.addEventListener("native-refresh-access", refresh);
		return () => window.removeEventListener("native-refresh-access", refresh);
	}, [session]);
	return (
		<main style={{ padding: 32 }}>
			<CaseDataManager
				appId={appId}
				caseTypes={caseTypes}
				effectiveCaseTypes={caseTypes}
				moduleUuidByCaseType={{ patient: moduleUuid }}
				initialCaseType="patient"
				canEdit={canEdit}
			/>
			<button type="button" style={{ position: "fixed", bottom: 24, left: 24 }}>
				Outside action
			</button>
			<ToastContainer />
		</main>
	);
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing component root");
createRoot(root).render(
	<BuilderSessionProvider
		init={{
			appId,
			projectId: "native-project",
			role: canEdit ? "editor" : "viewer",
			canEdit,
		}}
	>
		<BlueprintDocProvider
			appId={appId}
			initialDoc={persisted}
			canEdit={canEdit}
		>
			<Surface />
		</BlueprintDocProvider>
	</BuilderSessionProvider>,
);
