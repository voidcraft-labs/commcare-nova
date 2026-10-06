import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	BuilderLocalizationProvider,
	useBuilderLanguage,
} from "@/components/builder/localization/BuilderLocalizationProvider";
import { FormLayoutProvider } from "@/components/preview/form/FormLayoutContext";
import {
	__resetAttachmentCoordinatorForTests,
	setAttachmentEntryAuthority,
} from "@/components/preview/form/fields/attachment/attachmentClient";
import { InteractiveFormRenderer } from "@/components/preview/form/InteractiveFormRenderer";
import { buildDoc, f, xp } from "@/lib/__tests__/docHelpers";
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

const initialization = new URLSearchParams(window.location.search).has(
	"initialization",
);
const languageJourney = new URLSearchParams(window.location.search).has(
	"language",
);
function languageDoc() {
	const doc = buildDoc({
		appId: "native-worker-language",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							{
								kind: "group",
								id: "visit",
								label: "Visit details",
								children: [
									{
										kind: "date",
										id: "date",
										label: "Visit date",
										required: "true()",
									},
									{
										kind: "datetime",
										id: "recorded_at",
										label: "Recorded at",
										default_value: "'2024-01-15T14:30:00.000-05:00'",
									},
									{ kind: "geopoint", id: "location", label: "Visit location" },
									{ kind: "text", id: "notes", label: "" },
								],
							},
							{
								kind: "repeat",
								id: "visits",
								label: "Visits",
								repeat_mode: "user_controlled",
								children: [{ kind: "text", id: "notes", label: "Visit note" }],
							},
						],
					},
				],
			},
		],
	});
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
		translations: { spa: {} },
	};
	return doc;
}
function presentationDoc() {
	const doc = buildDoc({
		appId: "native-worker-presentation",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							{
								kind: "label",
								id: "intro",
								label: "Review this visit before continuing",
							},
							{
								kind: "repeat",
								id: "processing",
								repeat_mode: "count_bound",
								repeat_count: "2",
								children: [{ kind: "hidden", id: "computed", calculate: "7" }],
							},
							{
								kind: "repeat",
								id: "query_processing",
								repeat_mode: "query_bound",
								data_source: { ids_query: "'first second'" },
								children: [
									{
										kind: "hidden",
										id: "row_id",
										calculate: "current()/../@id",
									},
								],
							},
							{
								kind: "repeat",
								id: "manual",
								repeat_mode: "user_controlled",
								children: [{ kind: "hidden", id: "computed", calculate: "3" }],
							},
							{ kind: "text", id: "show_details", label: "Show entry details" },
							{
								kind: "repeat",
								id: "details",
								repeat_mode: "count_bound",
								repeat_count: "2",
								children: [
									{
										kind: "label",
										id: "prompt",
										label: "Visible entry detail",
										relevant: "#form/show_details = 'yes' and position(..) = 0",
									},
								],
							},
							{
								kind: "label",
								id: "review",
								label: "Your visit is ready to review",
							},
						],
					},
				],
			},
		],
	});
	for (const field of Object.values(doc.fields))
		if (field.kind === "repeat") delete field.label;
	return doc;
}
const defaultDoc = admittedControllerDoc(
	initialization
		? buildDoc({
				appId: "native-repeat-initialization",
				modules: [
					{
						name: "Visits",
						forms: [
							{
								name: "Visit",
								type: "survey",
								fields: [
									f({
										kind: "text",
										id: "zone",
										label: proseText("New visit zone"),
										default_value: "'north'",
									}),
									f({
										kind: "repeat",
										id: "visits",
										label: proseText("Visits"),
										repeat_mode: "user_controlled",
										children: [
											f({
												kind: "hidden",
												id: "zone",
												default_value: "#form/zone",
											}),
											f({
												kind: "repeat",
												id: "assets",
												label: proseText("Assets"),
												repeat_mode: "query_bound",
												data_source: {
													ids_query:
														"if(#form/visits/zone = 'north', 'pump tap', 'tank')",
												},
												children: [
													f({
														kind: "text",
														id: "note",
														label: proseText("Asset note"),
														default_value: "current()/../@id",
													}),
												],
											}),
										],
									}),
								],
							},
						],
					},
				],
			})
		: buildDoc({
				appId: "native-repeats",
				modules: [
					{
						name: "Patients",
						forms: [
							{
								name: "Visit",
								type: "survey",
								fields: [
									f({ kind: "hidden", id: "audit", calculate: xp("1") }),
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
												kind: "hidden",
												id: "computed",
												calculate: xp("1"),
											}),
											f({
												kind: "text",
												id: "extra",
												label: proseText("Extra detail"),
												relevant: xp("/data/visits/size > 1"),
											}),
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
															index === 0
																? "Visit outcome"
																: "Symptoms observed",
														),
														optionsSource: {
															kind: "inline",
															options: ["First", "Second"].map(
																(label, option) => ({
																	uuid: testUuid(`repeat-${kind}-${option}`),
																	value: label.toLowerCase(),
																	label: proseText(label),
																}),
															),
														},
													}),
											),
											f({
												kind: "geopoint",
												id: "location",
												label: proseText("Visit location"),
											}),
											f({
												kind: "image",
												id: "photo",
												label: proseText("Photo"),
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
const doc = languageJourney
	? admittedControllerDoc(languageDoc())
	: new URLSearchParams(window.location.search).has("presentation")
		? admittedControllerDoc(presentationDoc())
		: defaultDoc;
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
function LanguageChoices() {
	const { selectLanguage } = useBuilderLanguage();
	return (
		<>
			<button type="button" onClick={() => selectLanguage("eng")}>
				English
			</button>
			<button type="button" onClick={() => selectLanguage("spa")}>
				Español
			</button>
		</>
	);
}
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
				{languageJourney && <LanguageChoices />}
				<BuilderFormEngineProvider>
					<RunningForm />
				</BuilderFormEngineProvider>
			</BuilderLocalizationProvider>
		</BuilderSessionContext>
	</BlueprintDocContext>,
);
window.previewRepeatsAudit = {
	answerValues() {
		return Object.fromEntries(
			Object.values(activeController?.store.getState() ?? {}).map((state) => [
				state.path,
				state.value,
			]),
		);
	},
	calculationValues() {
		const states = activeController?.store.getState() ?? {};
		return Object.fromEntries(
			Object.entries(states)
				.filter(([path]) =>
					/^\/data\/(processing|query_processing)\[/.test(path),
				)
				.map(([path, state]) => [path, state.value]),
		);
	},
	async dispose() {
		root.unmount();
		await activeController?.awaitSettled();
		await __resetAttachmentCoordinatorForTests();
	},
};
declare global {
	interface Window {
		previewRepeatsAudit: {
			answerValues(): Record<string, string>;
			calculationValues(): Record<string, string>;
			dispose(): Promise<void>;
		};
	}
}
