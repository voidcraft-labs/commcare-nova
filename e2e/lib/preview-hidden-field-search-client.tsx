import { createRoot } from "react-dom/client";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BuilderLocalizationProvider } from "@/components/builder/localization/BuilderLocalizationProvider";
import { CaseListScreen } from "@/components/preview/screens/CaseListScreen";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { plainColumn, proseText, simpleSearchInputDef } from "@/lib/domain";
import { admittedControllerDoc } from "@/lib/preview/engine/__tests__/fixtures/controllerDoc";
import { BuilderFormEngineProvider } from "@/lib/preview/engine/provider";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";
import { searchReads } from "./preview-search-reads-boundary";

/* One list whose search has a single field, Region, which Web Apps does
 * not draw and which starts at north. `?skip` opens the menu on its
 * Results (skip to results), where the menu runs its default search;
 * otherwise the menu opens on its Search screen. */
const params = new URLSearchParams(location.search);
const skip = params.has("skip");
const moduleUuid = testUuid("hidden-field-search-module");
const doc = admittedControllerDoc(
	buildDoc({
		appId: "native-cases",
		appName: "Hidden field search",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name"), data_type: "text" },
					{ name: "region", label: proseText("Region"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: moduleUuid,
				name: "Clients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(
							testUuid("hidden-field-search-name"),
							"case_name",
							"Name",
						),
					],
					searchInputs: [
						simpleSearchInputDef(
							testUuid("hidden-field-search-region"),
							"region",
							"Region",
							"text",
							"region",
							{
								hidden: true,
								default: {
									kind: "term",
									term: { kind: "literal", value: "north" },
								},
							},
						),
					],
				},
				...(skip && { caseSearchConfig: { workflow: "skipToResults" } }),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [{ kind: "text", id: "notes", label: "Notes" }],
					},
				],
			},
		],
	}),
);
const session = createBuilderSessionStore({
	appId: "native-cases",
	projectId: "native-project",
	role: "editor",
	canEdit: true,
});
session.getState().setPreviewing(true);
session.getState().setPreviewPlatform("web-apps");
const element = document.getElementById("root");
if (!element) throw new Error("Missing root");
const root = createRoot(element);
pushBuilderHistory(`/build/native-cases/${moduleUuid}/results`);
root.render(
	<BuilderSessionContext value={session}>
		<BlueprintDocProvider appId="native-cases" initialDoc={doc}>
			<BuilderLocalizationProvider>
				<BuilderFormEngineProvider>
					<CaseListScreen screen={{ type: "caseList", moduleUuid }} current />
				</BuilderFormEngineProvider>
			</BuilderLocalizationProvider>
		</BlueprintDocProvider>
	</BuilderSessionContext>,
);
window.previewHiddenFieldSearch = {
	reads: () => searchReads,
	dispose: () => root.unmount(),
};
declare global {
	interface Window {
		previewHiddenFieldSearch: {
			reads(): typeof searchReads;
			dispose(): void;
		};
	}
}
