import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BuilderLocalizationProvider } from "@/components/builder/localization/BuilderLocalizationProvider";
import { __resetAttachmentCoordinatorForTests } from "@/components/preview/form/fields/attachment/attachmentClient";
import { FormScreen } from "@/components/preview/screens/FormScreen";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { admittedControllerDoc } from "@/lib/preview/engine/__tests__/fixtures/controllerDoc";
import type { EngineController } from "@/lib/preview/engine/engineController";
import {
	BuilderFormEngineProvider,
	useBuilderFormEngine,
} from "@/lib/preview/engine/provider";
import { PreviewCaseDatabaseProvider } from "@/lib/preview/engine/useCaseDatabaseSnapshot";
import { invalidateCaseData } from "@/lib/preview/hooks/caseDataInvalidation";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";

import { configureEmptyDatabase } from "./preview-selected-entry-boundary";

const entryMode = new URLSearchParams(window.location.search).get("entry");
if (entryMode === "empty") configureEmptyDatabase();
const doc = admittedControllerDoc(
	buildDoc({
		appId: "selected-entry",
		appName: "Room inspection",
		caseTypes: [{ name: "room", properties: [] }],
		modules: [
			{
				name: "Rooms",
				caseType: "room",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Room" },
				]),
				forms: [
					{
						name: "Inspect room",
						type: "followup",
						fields: [
							f({
								id: "room_name",
								kind: "text",
								label: "Room name",
								default_value: "#room/case_name",
							}),
							f({
								id: "checks",
								kind: "repeat",
								label: "Checks",
								repeat_mode: "query_bound",
								data_source: {
									ids_query:
										"instance('casedb')/casedb/case[@case_id = #room/case_id]/@case_id",
								},
								children: [
									f({
										id: "note",
										kind: "text",
										label: "Inspection note",
										required: "true()",
										default_value: "current()/../@id",
									}),
								],
							}),
						],
					},
				],
			},
		],
	}),
);
const moduleUuid = doc.moduleOrder[0],
	formUuid = doc.formOrder[moduleUuid][0];
const store = createBlueprintDocStore();
store.getState().load(doc);
store.getState().startTracking();
const session = createBuilderSessionStore({
	appId: doc.appId,
	projectId: "project-a",
	role: "editor",
	canEdit: true,
});
session.getState().setPreviewing(true);
let controller: EngineController | undefined;
function Capture() {
	const c = useBuilderFormEngine();
	useEffect(() => {
		controller = c;
		return () => {
			controller = undefined;
		};
	}, [c]);
	return null;
}
const element = document.getElementById("root");
if (!element) throw new Error("Missing root");
element.style.height = "calc(100vh - 32px)";
const root = createRoot(element);
pushBuilderHistory(`/build/${doc.appId}/${moduleUuid}/${formUuid}`);
root.render(
	<BuilderSessionContext value={session}>
		<BlueprintDocContext value={store}>
			<BuilderLocalizationProvider>
				<BuilderFormEngineProvider>
					<PreviewCaseDatabaseProvider>
						<Capture />
						<button
							type="button"
							onClick={async () => {
								await controller?.awaitSettled();
								invalidateCaseData(doc.appId, "room");
							}}
						>
							Refresh record
						</button>
						<FormScreen
							screen={{
								type: "form",
								moduleUuid,
								formUuid,
								cases:
									entryMode === "blank"
										? []
										: entryMode === "empty"
											? undefined
											: [{ caseId: "selected-room" }],
							}}
							onBack={() => {}}
						/>
					</PreviewCaseDatabaseProvider>
				</BuilderFormEngineProvider>
			</BuilderLocalizationProvider>
		</BlueprintDocContext>
	</BuilderSessionContext>,
);
window.selectedEntryAudit = {
	async dispose() {
		const owned = controller;
		root.unmount();
		await owned?.awaitSettled();
		await __resetAttachmentCoordinatorForTests();
	},
};
declare global {
	interface Window {
		selectedEntryAudit: {
			dispose(): Promise<void>;
		};
	}
}
