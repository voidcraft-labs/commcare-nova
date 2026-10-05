import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BuilderLocalizationProvider } from "@/components/builder/localization/BuilderLocalizationProvider";
import { LanguageSelector } from "@/components/builder/localization/LanguageSelector";
import { __resetAttachmentCoordinatorForTests } from "@/components/preview/form/fields/attachment/attachmentClient";
import { FormScreen } from "@/components/preview/screens/FormScreen";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import {
	admittedControllerDoc,
	applyControllerEdit,
} from "@/lib/preview/engine/__tests__/fixtures/controllerDoc";
import {
	liveCountEntryDoc,
	sectionEntryDoc,
} from "@/lib/preview/engine/__tests__/fixtures/sectionEntry";
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
import {
	armValidationWorker,
	releaseValidationWorker,
	validationWorkerHeld,
} from "./preview-form-lifecycle-boundary";

const MODULE = testUuid("native-form-module"),
	FORM = testUuid("native-form-survey");
const NAME = testUuid("native-form-name"),
	PHOTO = testUuid("native-form-photo");
const numbers = new URLSearchParams(location.search).has("numbers");
const drafts = new URLSearchParams(location.search).has("drafts");
const sections = new URLSearchParams(location.search).has("sections");
const caseDatabase = new URLSearchParams(location.search).has("case-database");
const registration = drafts || caseDatabase;
const doc = admittedControllerDoc(
	new URLSearchParams(location.search).has("live-counts")
		? liveCountEntryDoc()
		: sections
			? sectionEntryDoc()
			: buildDoc({
					appId: "native-form",
					appName: "Form lifecycle",
					caseTypes: registration
						? [{ name: "visit", properties: [] }]
						: undefined,
					modules: [
						{
							uuid: MODULE,
							name: "Visits",
							caseType: registration ? "visit" : undefined,
							caseListConfig: registration
								? caseListConfig([{ field: "case_name", header: "Name" }])
								: undefined,
							forms: [
								{
									uuid: FORM,
									name: "Visit",
									type: registration ? "registration" : "survey",
									...(caseDatabase ? { postSubmit: "previous" as const } : {}),
									fields: [
										{
											uuid: NAME,
											id: "name",
											kind: "text",
											label: "Name",
											required: "true()",
											...(caseDatabase ? { validate: ". != ''" } : {}),
											...(registration
												? {
														caseWrite: {
															caseType: "visit",
															property: "case_name",
														},
													}
												: {}),
										},
										{ uuid: PHOTO, id: "photo", kind: "image", label: "Photo" },
										...(drafts
											? [
													{
														uuid: testUuid("native-form-place"),
														id: "place",
														kind: "geopoint" as const,
														label: "Location",
														caseWrite: { caseType: "visit", property: "place" },
													},
													{
														uuid: testUuid("native-form-clock"),
														id: "clock",
														kind: "time" as const,
														label: "Time",
														caseWrite: { caseType: "visit", property: "clock" },
													},
												]
											: []),
										...(numbers
											? [
													{
														uuid: testUuid("native-form-count"),
														id: "count",
														kind: "int" as const,
														label: "Count",
													},
													{
														uuid: testUuid("native-form-quantity"),
														id: "quantity",
														kind: "decimal" as const,
														label: "Quantity",
													},
												]
											: []),
									],
								},
							],
						},
					],
				}),
);
const activeModule = doc.moduleOrder[0];
const activeForm = doc.formOrder[activeModule][0];
const docStore = createBlueprintDocStore();
docStore.getState().load(doc);
docStore.getState().startTracking();
applyControllerEdit(docStore, [
	{ kind: "addLanguage", language: { language: "spa" } },
]);
const session = createBuilderSessionStore({
	appId: doc.appId,
	projectId: "project-a",
	role: "editor",
	canEdit: true,
});
session.getState().setPreviewing(true);
let controller: EngineController | undefined;
function Capture() {
	const current = useBuilderFormEngine();
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
// Match the bounded Preview viewport that gives FormScreen its height.
element.style.height = "calc(100vh - 32px)";
const root = createRoot(element);
pushBuilderHistory(`/build/${doc.appId}/${activeModule}/${activeForm}`);
const formScreen = (
	<>
		<Capture />
		<FormScreen
			screen={{
				type: "form",
				moduleUuid: activeModule,
				formUuid: activeForm,
			}}
		/>
	</>
);
root.render(
	<BuilderSessionContext value={session}>
		<BlueprintDocContext value={docStore}>
			<BuilderLocalizationProvider>
				<LanguageSelector />
				<BuilderFormEngineProvider>
					{caseDatabase ? (
						<PreviewCaseDatabaseProvider>
							{formScreen}
						</PreviewCaseDatabaseProvider>
					) : (
						formScreen
					)}
				</BuilderFormEngineProvider>
			</BuilderLocalizationProvider>
		</BlueprintDocContext>
	</BuilderSessionContext>,
);
window.previewFormLifecycleAudit = {
	entry: () => controller?.entryKey,
	answers: () => ({
		name: controller?.store.getState()[NAME]?.value,
		photo: controller?.store.getState()[PHOTO]?.value,
	}),
	async armValidation() {
		await controller?.awaitSettled();
		const entryKey = controller?.entryKey;
		if (entryKey === undefined) throw new Error("Expected a form entry");
		armValidationWorker(entryKey);
	},
	validationHeld: validationWorkerHeld,
	releaseValidation: releaseValidationWorker,
	refreshCaseData() {
		invalidateCaseData(doc.appId, "visit");
	},
	async settled() {
		await controller?.awaitSettled();
	},
	refresh(projectId: string) {
		session.getState().beginAccessRefresh();
		session.getState().resetProjectScope();
		session
			.getState()
			.applyAccessSnapshot({ projectId, role: "editor", canEdit: true });
	},
	async dispose() {
		const owned = controller;
		root.unmount();
		releaseValidationWorker();
		await owned?.awaitSettled();
		await __resetAttachmentCoordinatorForTests();
	},
};
declare global {
	interface Window {
		previewFormLifecycleAudit: {
			entry(): string | undefined;
			answers(): { name?: string; photo?: string };
			armValidation(): Promise<void>;
			validationHeld(): boolean;
			releaseValidation(): void;
			refreshCaseData(): void;
			settled(): Promise<void>;
			refresh(projectId: string): void;
			dispose(): Promise<void>;
		};
	}
}
