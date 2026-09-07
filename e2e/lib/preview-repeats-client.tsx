import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BuilderLocalizationProvider } from "@/components/builder/localization/BuilderLocalizationProvider";
import { FormLayoutProvider } from "@/components/preview/form/FormLayoutContext";
import {
	__resetAttachmentCoordinatorForTests,
	setAttachmentEntryAuthority,
} from "@/components/preview/form/fields/attachment/attachmentClient";
import { InteractiveFormRenderer } from "@/components/preview/form/InteractiveFormRenderer";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { proseText } from "@/lib/domain";
import { admittedControllerDoc } from "@/lib/preview/engine/__tests__/fixtures/controllerDoc";
import type { EngineController } from "@/lib/preview/engine/engineController";
import {
	BuilderFormEngineProvider,
	useBuilderFormEngine,
} from "@/lib/preview/engine/provider";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";

const doc = admittedControllerDoc(
	buildDoc({
		appId: "native-repeats",
		modules: [
			{
				name: "Patients",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							...["first", "second"].map((id) =>
								f({
									kind: "group",
									id,
									label: proseText("Visit"),
									children: [
										f({
											kind: "image",
											id: "photo",
											label: proseText("Photo"),
										}),
									],
								}),
							),
							f({
								kind: "repeat",
								id: "visits",
								repeat_mode: "user_controlled",
								label: proseText("Visits"),
								children: [
									f({
										kind: "text",
										id: "patient",
										label: proseText("Related patient case id"),
									}),
									f({
										kind: "int",
										id: "size",
										label: proseText("Household size"),
									}),
									f({
										kind: "date",
										id: "date",
										label: proseText("Visit date"),
									}),
									...(["single_select", "multi_select"] as const).map(
										(kind, index) =>
											f({
												kind,
												id: `choice_${index}`,
												label: proseText(
													index === 0 ? "Visit outcome" : "Symptoms observed",
												),
												optionsSource: {
													kind: "inline",
													options: ["First", "Second"].map((label, option) => ({
														uuid: testUuid(`repeat-${kind}-${option}`),
														value: label.toLowerCase(),
														label: proseText(label),
													})),
												},
											}),
									),
									f({
										kind: "geopoint",
										id: "location",
										label: proseText("Visit location"),
									}),
									f({ kind: "image", id: "photo", label: proseText("Photo") }),
								],
							}),
						],
					},
				],
			},
		],
	}),
);
const moduleUuid = doc.moduleOrder[0];
const formUuid = doc.formOrder[moduleUuid][0];
const docStore = createBlueprintDocStore();
docStore.getState().load(doc);
const session = createBuilderSessionStore({
	appId: doc.appId,
	projectId: "project",
	role: "editor",
	canEdit: true,
});
session.getState().setPreviewing(true);
let activeController: EngineController | undefined;
function RunningForm() {
	const controller = useBuilderFormEngine();
	const [ready, setReady] = useState(false);
	useEffect(() => {
		activeController = controller;
		controller.activateForm(formUuid);
		const entryKey = controller.entryKey;
		if (!entryKey) throw new Error("Missing actual form entry");
		const snapshot = {
			appId: doc.appId,
			entryKey,
			formUuid,
			projectId: "project",
			actorUserId: "actor",
			ownerId: "actor",
			scopeEpoch: 0,
			accessPhase: "authorized" as const,
			canEdit: true,
		};
		setAttachmentEntryAuthority({
			entryKey,
			snapshot,
			readCurrent: () => ({
				...snapshot,
				entryKey: controller.entryKey,
				formUuid: controller.formUuid,
			}),
		});
		setReady(true);
		return () => controller.deactivate();
	}, [controller]);
	return ready ? (
		<FormLayoutProvider>
			<InteractiveFormRenderer parentEntityId={formUuid} />
		</FormLayoutProvider>
	) : null;
}
const target = document.getElementById("root");
if (!target) throw new Error("Missing root");
const root = createRoot(target);
root.render(
	<BlueprintDocContext value={docStore}>
		<BuilderSessionContext value={session}>
			<BuilderLocalizationProvider>
				<BuilderFormEngineProvider>
					<RunningForm />
				</BuilderFormEngineProvider>
			</BuilderLocalizationProvider>
		</BuilderSessionContext>
	</BlueprintDocContext>,
);
window.previewRepeatsAudit = {
	async dispose() {
		root.unmount();
		await activeController?.awaitSettled();
		await __resetAttachmentCoordinatorForTests();
	},
};
declare global {
	interface Window {
		previewRepeatsAudit: { dispose(): Promise<void> };
	}
}
