import { createRoot } from "react-dom/client";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BuilderLocalizationProvider } from "@/components/builder/localization/BuilderLocalizationProvider";
import { CaseListScreen } from "@/components/preview/screens/CaseListScreen";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { plainColumn, proseText, tileCell } from "@/lib/domain";
import { admittedControllerDoc } from "@/lib/preview/engine/__tests__/fixtures/controllerDoc";
import { BuilderFormEngineProvider } from "@/lib/preview/engine/provider";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";

/* One list over the boundary's one case, shown by its name alone. In the
 * row layout `field_4` ("Fourth value") is a column hidden from Results; in
 * the tile layout `field_5` ("Fifth value") is a hidden column that orders
 * the list, which rides as a carrier with no stored field. Neither value is
 * on screen, so only the quick filter's reach can find the case by it. */
const layout =
	new URLSearchParams(location.search).get("layout") === "tile"
		? "tile"
		: "rows";
const moduleUuid = testUuid("hidden-search-module");
const nameColumn = plainColumn(
	testUuid("hidden-search-name"),
	"case_name",
	"Name",
	layout === "tile" ? { tile: tileCell(0, 0, 12, 1) } : {},
);
const hiddenColumn =
	layout === "tile"
		? plainColumn(testUuid("hidden-search-carrier"), "field_5", "Fifth", {
				visibleInList: false,
				sort: { direction: "asc", priority: 0 },
			})
		: plainColumn(testUuid("hidden-search-hidden"), "field_4", "Fourth", {
				visibleInList: false,
			});
const doc = admittedControllerDoc(
	buildDoc({
		appId: "native-cases",
		appName: "Hidden search",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name"), data_type: "text" },
					{ name: "field_4", label: proseText("Fourth"), data_type: "text" },
					{ name: "field_5", label: proseText("Fifth"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: moduleUuid,
				name: "Clients",
				caseType: "patient",
				caseListConfig: {
					columns: [nameColumn, hiddenColumn],
					searchInputs: [],
					...(layout === "tile" ? { tile: {} } : {}),
				},
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
const element = document.getElementById("root");
if (!element) throw new Error("Missing root");
const root = createRoot(element);
pushBuilderHistory(`/build/native-cases/${moduleUuid}/results`);
root.render(
	<BuilderSessionContext value={session}>
		<BlueprintDocProvider appId="native-cases" initialDoc={doc}>
			<BuilderLocalizationProvider>
				<BuilderFormEngineProvider>
					<CaseListScreen screen={{ type: "caseList", moduleUuid }} />
				</BuilderFormEngineProvider>
			</BuilderLocalizationProvider>
		</BlueprintDocProvider>
	</BuilderSessionContext>,
);
window.previewHiddenSearch = { dispose: () => root.unmount() };
declare global {
	interface Window {
		previewHiddenSearch: { dispose(): void };
	}
}
