import { useEffect, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { testUuid } from "@/__tests__/helpers/uuid";
import { EditGuardProvider } from "@/components/builder/contexts/EditGuardContext";
import { ScrollRegistryProvider } from "@/components/builder/contexts/ScrollRegistryContext";
import { BuilderLocalizationProvider } from "@/components/builder/localization/BuilderLocalizationProvider";
import { FormScreen } from "@/components/preview/screens/FormScreen";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import {
	admittedControllerDoc,
	applyControllerEdit,
} from "@/lib/preview/engine/__tests__/fixtures/controllerDoc";
import type { EngineController } from "@/lib/preview/engine/engineController";
import {
	BuilderFormEngineProvider,
	useBuilderFormEngine,
} from "@/lib/preview/engine/provider";
import { PreviewCaseDatabaseProvider } from "@/lib/preview/engine/useCaseDatabaseSnapshot";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";
import { usePreviewDevice } from "@/lib/session/hooks";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";

const MODULE = testUuid("choice-check-module"),
	FORM = testUuid("choice-check-form"),
	FIELD = testUuid("choice-check-field");
const options = [
	{ value: "yes", label: "Yes" },
	{ value: "no", label: "No" },
];
const doc = admittedControllerDoc(
	buildDoc({
		appId: "choice-check",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{
						name: "stage",
						label: "Stage",
						data_type: "single_select",
						options,
					},
				],
			},
		],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "followup",
						fields: [
							{
								uuid: FIELD,
								id: "stage",
								kind: "single_select",
								label: "Stage",
								options,
								default_value: "#patient/stage",
							},
						],
					},
				],
			},
		],
	}),
);
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
if (new URLSearchParams(location.search).has("android"))
	session.getState().setPreviewPlatform("android");
let controller: EngineController | undefined;
function Capture() {
	const current = useBuilderFormEngine();
	const device = usePreviewDevice();
	useLayoutEffect(() => {
		current.setPreviewDevice(device);
	}, [current, device]);
	useEffect(() => {
		controller = current;
		return () => {
			controller = undefined;
		};
	}, [current]);
	return null;
}
const element = document.getElementById("root");
if (!element) throw new Error("Missing root");
element.style.height = "calc(100vh - 32px)";
const root = createRoot(element);
pushBuilderHistory(`/build/${doc.appId}/${MODULE}/${FORM}`);
root.render(
	<BuilderSessionContext value={session}>
		<BlueprintDocContext value={store}>
			<ScrollRegistryProvider>
				<EditGuardProvider>
					<BuilderLocalizationProvider>
						<BuilderFormEngineProvider>
							<PreviewCaseDatabaseProvider>
								<Capture />
								<FormScreen
									screen={{
										type: "form",
										moduleUuid: MODULE,
										formUuid: FORM,
										cases: [{ caseId: "old-record", caseName: "Old record" }],
									}}
								/>
							</PreviewCaseDatabaseProvider>
						</BuilderFormEngineProvider>
					</BuilderLocalizationProvider>
				</EditGuardProvider>
			</ScrollRegistryProvider>
		</BlueprintDocContext>
	</BuilderSessionContext>,
);
window.choiceCheckAudit = {
	answer: () => controller?.store.getState()[FIELD]?.value,
	repair() {
		applyControllerEdit(store, [
			{
				kind: "updateField",
				targetKind: "single_select",
				uuid: FIELD,
				patch: { default_value: null },
			},
		]);
	},
	resume: () => session.getState().setPreviewing(true),
	previewing: () => session.getState().previewing,
	async dispose() {
		const owned = controller;
		root.unmount();
		await owned?.awaitSettled();
	},
};
declare global {
	interface Window {
		choiceCheckAudit: {
			answer(): string | undefined;
			repair(): void;
			resume(): void;
			previewing(): boolean;
			dispose(): Promise<void>;
		};
	}
}
