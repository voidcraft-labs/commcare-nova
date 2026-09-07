import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppTree } from "@/components/builder/appTree/AppTree";
import { AppTreeRail } from "@/components/builder/appTree/AppTreeRail";
import { ScrollRegistryProvider } from "@/components/builder/contexts/ScrollRegistryContext";
import { BuilderLocalizationProvider } from "@/components/builder/localization/BuilderLocalizationProvider";
import { ToastContainer } from "@/components/ui/ToastContainer";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { evaluateCommit } from "@/lib/commcare/validator/gate";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { blueprintDocSchema } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { useLocation } from "@/lib/routing/hooks";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";
import { BuilderSessionProvider } from "@/lib/session/provider";

const scenario = new URLSearchParams(location.search).get("scenario");
const canEdit = scenario !== "viewer" && scenario !== "locked";
const appId = "native-app-tree";
const source = buildDoc({
	appName: "Native tree",
	caseTypes: [{ name: "patient_case", properties: [] }],
	modules: [
		{
			uuid: "tree-care",
			name: "Care",
			caseType: "patient_case",
			caseListOnly: true,
			caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
			forms: [],
		},
		{
			uuid: "tree-visits",
			name: "Visits",
			forms: [
				{
					uuid: "tree-visit-form",
					name: "Follow up",
					type: "survey",
					fields: [
						f({
							kind: "text",
							id: "home_address",
							label: proseText("Home address"),
						}),
						f({ kind: "text", id: "notes", label: proseText("Visit notes") }),
					],
				},
			],
		},
		{
			uuid: "tree-outreach",
			name: "Outreach",
			forms: [
				{
					uuid: "tree-outreach-form",
					name: "Screening",
					type: "survey",
					fields: [
						f({
							kind: "text",
							id: "contact_name",
							label: proseText("Contact name"),
						}),
					],
				},
			],
		},
	],
});
source.appId = appId;
const [careUuid, visitsUuid] = source.moduleOrder;
if (!careUuid || !visitsUuid) throw new Error("Missing tree modules");
source.modules[visitsUuid].parentModuleUuid = careUuid;
const persisted = blueprintDocSchema.parse(
	JSON.parse(JSON.stringify(toPersistableDoc(source))),
);
const admitted = evaluateCommit({
	nextDoc: source,
	lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
});
if (!admitted.ok) throw new Error(JSON.stringify(admitted.findings));
pushBuilderHistory(`/a/${appId}`);
function Surface() {
	const [rail, setRail] = useState(false);
	const doc = useBlueprintDoc((value) => value);
	const location = useLocation();
	const mutations = useBlueprintMutations();
	return (
		<main style={{ display: "flex", height: 680, padding: 16, gap: 20 }}>
			<section
				aria-label="Structure"
				style={{ width: rail ? 56 : 390, height: "100%" }}
			>
				{rail ? (
					<AppTreeRail onExpand={() => setRail(false)} />
				) : (
					<>
						<button type="button" onClick={() => setRail(true)}>
							Show compact structure
						</button>
						<AppTree />
					</>
				)}
			</section>
			<section aria-label="Document observations">
				<output aria-label="Current route">{JSON.stringify(location)}</output>
				<output aria-label="Saved blueprint" style={{ display: "none" }}>
					{JSON.stringify(toPersistableDoc(doc))}
				</output>
				<button
					type="button"
					onClick={() => {
						const outcome = mutations.updateModule(visitsUuid, {
							name: "Home visits",
						});
						if (!outcome.ok) throw new Error("Peer rename refused");
					}}
				>
					Peer renames Visits
				</button>
			</section>
			<ToastContainer />
		</main>
	);
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing tree root");
createRoot(root).render(
	<BuilderSessionProvider
		init={{
			appId,
			projectId: "native-project",
			role: canEdit ? "editor" : "viewer",
			canEdit,
			buildUnfinished: scenario === "locked",
		}}
	>
		<BlueprintDocProvider
			appId={appId}
			initialDoc={persisted}
			canEdit={canEdit}
		>
			<BuilderLocalizationProvider>
				<ScrollRegistryProvider>
					<Surface />
				</ScrollRegistryProvider>
			</BuilderLocalizationProvider>
		</BlueprintDocProvider>
	</BuilderSessionProvider>,
);
