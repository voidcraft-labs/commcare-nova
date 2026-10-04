import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BuilderLocalizationProvider } from "@/components/builder/localization/BuilderLocalizationProvider";
import { __resetAttachmentCoordinatorForTests } from "@/components/preview/form/fields/attachment/attachmentClient";
import { FormScreen } from "@/components/preview/screens/FormScreen";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
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

const MODULE = testUuid("choice-activation-module");
const FORM = testUuid("choice-activation-form");
const AGE = testUuid("choice-activation-age");
const ERROR =
	"Enter an age from 0 to 120. Please correct this answer before continuing. Esta respuesta debe ser un número entre cero y ciento veinte.";
const doc = admittedControllerDoc(
	buildDoc({
		appId: "native-choice-activation",
		appName: "Choice activation",
		caseTypes: [{ name: "visit", properties: [] }],
		modules: [
			{
				uuid: MODULE,
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "registration",
						fields: [
							{
								uuid: testUuid("choice-activation-name"),
								id: "name",
								kind: "text",
								label: "Name",
								required: "true()",
								caseWrite: { caseType: "visit", property: "case_name" },
							},
							{
								uuid: AGE,
								id: "age",
								kind: "int",
								label: "Age",
								required: "true()",
								validate: "#form/age >= 0 and #form/age <= 120",
								validate_msg: ERROR,
								caseWrite: { caseType: "visit", property: "age" },
							},
							{
								uuid: testUuid("choice-activation-route"),
								id: "route",
								kind: "single_select",
								label: "Preferred route",
								optionsSource: {
									kind: "inline",
									options: [
										{
											uuid: testUuid("choice-phone"),
											value: "phone",
											label: "Phone",
										},
										{
											uuid: testUuid("choice-email"),
											value: "email",
											label: "Email",
										},
										{
											uuid: testUuid("choice-help"),
											value: "help",
											label: "[Read help](https://example.invalid/help)",
										},
									],
								},
							},
							{
								uuid: testUuid("choice-activation-services"),
								id: "services",
								kind: "multi_select",
								label: "Services",
								optionsSource: {
									kind: "inline",
									options: [
										{
											uuid: testUuid("choice-one"),
											value: "one",
											label: "Service one",
										},
										{
											uuid: testUuid("choice-two"),
											value: "two",
											label: "Service two",
										},
									],
								},
							},
							{
								uuid: testUuid("choice-activation-clock"),
								id: "clock",
								kind: "time",
								label: "Time",
								caseWrite: { caseType: "visit", property: "clock" },
							},
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

// Observe native events only. The fixture never installs activation handlers,
// injects CSS, changes answers, or dispatches choice events.
const changes: { kind: string; value: string; trusted: boolean }[] = [];
let pointerCancelled = false;
function observeChange(event: Event) {
	const input = event.target;
	if (
		input instanceof HTMLInputElement &&
		(input.type === "radio" || input.type === "checkbox")
	)
		changes.push({
			kind: input.type,
			value: input.value,
			trusted: event.isTrusted,
		});
}
function observeCancel(event: Event) {
	if (event.isTrusted) pointerCancelled = true;
}
document.addEventListener("change", observeChange, true);
document.addEventListener("pointercancel", observeCancel, true);
const element = document.getElementById("root");
if (!element) throw new Error("Missing root");
element.style.height = "calc(100vh - 32px)";
const root = createRoot(element);
pushBuilderHistory(`/build/${doc.appId}/${MODULE}/${FORM}`);
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
window.previewChoiceActivation = {
	error: ERROR,
	observation: () => ({
		changes,
		pointerCancelled,
		age: controller?.store.getState()[AGE],
	}),
	settled: async () => {
		await controller?.awaitSettled();
	},
	async dispose() {
		document.removeEventListener("change", observeChange, true);
		document.removeEventListener("pointercancel", observeCancel, true);
		const owned = controller;
		root.unmount();
		await owned?.awaitSettled();
		await __resetAttachmentCoordinatorForTests();
	},
};
declare global {
	interface Window {
		previewChoiceActivation: {
			error: string;
			observation(): {
				changes: { kind: string; value: string; trusted: boolean }[];
				pointerCancelled: boolean;
				age: import("@/lib/preview/engine/types").FieldState | undefined;
			};
			settled(): Promise<void>;
			dispose(): Promise<void>;
		};
	}
}
