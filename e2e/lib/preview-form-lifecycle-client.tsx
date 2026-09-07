import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BuilderLocalizationProvider } from "@/components/builder/localization/BuilderLocalizationProvider";
import { __resetAttachmentCoordinatorForTests } from "@/components/preview/form/fields/attachment/attachmentClient";
import { FormScreen } from "@/components/preview/screens/FormScreen";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { admittedControllerDoc } from "@/lib/preview/engine/__tests__/fixtures/controllerDoc";
import type { EngineController } from "@/lib/preview/engine/engineController";
import {
	BuilderFormEngineProvider,
	useBuilderFormEngine,
} from "@/lib/preview/engine/provider";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";

const MODULE = testUuid("native-form-module"),
	FORM = testUuid("native-form-survey");
const NAME = testUuid("native-form-name"),
	PHOTO = testUuid("native-form-photo");
const doc = admittedControllerDoc(
	buildDoc({
		appId: "native-form",
		appName: "Form lifecycle",
		modules: [
			{
				uuid: MODULE,
				name: "Visits",
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "survey",
						fields: [
							{
								uuid: NAME,
								id: "name",
								kind: "text",
								label: "Name",
								required: "true()",
							},
							{ uuid: PHOTO, id: "photo", kind: "image", label: "Photo" },
						],
					},
				],
			},
		],
	}),
);
const docStore = createBlueprintDocStore();
docStore.getState().load(doc);
docStore.getState().startTracking();
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
const root = createRoot(element);
pushBuilderHistory(`/build/native-form/${MODULE}/${FORM}`);
root.render(
	<BuilderSessionContext value={session}>
		<BlueprintDocContext value={docStore}>
			<BuilderLocalizationProvider>
				<BuilderFormEngineProvider>
					<Capture />
					<FormScreen
						screen={{ type: "form", moduleUuid: MODULE, formUuid: FORM }}
						onBack={() => {}}
					/>
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
		await owned?.awaitSettled();
		await __resetAttachmentCoordinatorForTests();
	},
};
declare global {
	interface Window {
		previewFormLifecycleAudit: {
			entry(): string | undefined;
			answers(): { name?: string; photo?: string };
			refresh(projectId: string): void;
			dispose(): Promise<void>;
		};
	}
}
