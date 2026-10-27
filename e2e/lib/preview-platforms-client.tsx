import { useEffect, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { testUuid } from "@/__tests__/helpers/uuid";
import { EditGuardProvider } from "@/components/builder/contexts/EditGuardContext";
import { ScrollRegistryProvider } from "@/components/builder/contexts/ScrollRegistryContext";
import { BuilderLocalizationProvider } from "@/components/builder/localization/BuilderLocalizationProvider";
import { __resetAttachmentCoordinatorForTests } from "@/components/preview/form/fields/attachment/attachmentClient";
import { FormScreen } from "@/components/preview/screens/FormScreen";
import { HomeScreen } from "@/components/preview/screens/HomeScreen";
import { ToastContainer } from "@/components/ui/ToastContainer";
import { buildDoc, type FieldSpec } from "@/lib/__tests__/docHelpers";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Platform } from "@/lib/domain/platforms";
import { admittedControllerDoc } from "@/lib/preview/engine/__tests__/fixtures/controllerDoc";
import type { EngineController } from "@/lib/preview/engine/engineController";
import {
	BuilderFormEngineProvider,
	useBuilderFormEngine,
} from "@/lib/preview/engine/provider";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";
import { usePreviewDevice } from "@/lib/session/hooks";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";
import {
	PREVIEW_PLATFORM_SCENARIOS,
	type PreviewPlatformFixture,
	type PreviewPlatformScenarioId,
} from "./previewPlatformScenarios";
import { MARKDOWN_LABEL_TEXT, PLATFORM_IDS } from "./previewPlatformsFixture";

/**
 * The component peer of `e2e/tests/browser/preview-platforms.spec.ts`:
 * `?scenario=<id>` mounts the scenario's fixture document running as the
 * scenario's platform, through the production form screen (or the module
 * list, for `home`), with the device that platform plays installed as the
 * running shell installs it. Search scenarios run in the search peer
 * (`preview-search-client.tsx`) instead.
 *
 * Every fixture but `screens` holds its questions in one section, so Android
 * shows them together on one section page; `screens` has no sections, so
 * Android pages it a screen at a time: a question, a labeled group, a
 * labeled group in each repeat entry, an unlabeled group's questions one by
 * one, and a labeled group holding a repeat the worker adds to.
 */

const scenarioId = new URLSearchParams(location.search).get(
	"scenario",
) as PreviewPlatformScenarioId | null;
if (scenarioId === null || !(scenarioId in PREVIEW_PLATFORM_SCENARIOS))
	throw new Error(`No scenario named ${String(scenarioId)}.`);
const scenario = PREVIEW_PLATFORM_SCENARIOS[scenarioId];
const platform: Platform = scenario.platform;

const IDS = PLATFORM_IDS;

function inSection(label: string, children: FieldSpec[]): FieldSpec {
	return {
		kind: "section",
		id: "questions",
		uuid: testUuid("platforms-section"),
		label,
		children,
	};
}

function fieldsOf(fixture: PreviewPlatformFixture): FieldSpec[] {
	switch (fixture) {
		case "questions":
			return [
				inSection("Questions", [
					{ uuid: IDS.place, kind: "geopoint", id: "place", label: "Place" },
					{ uuid: IDS.code, kind: "barcode", id: "code", label: "Code" },
					{
						uuid: IDS.name,
						kind: "text",
						id: "name",
						label: "Name",
						hint: "Use **bold** words",
						help: "Ask for the **full** name",
						validate: ". != 'bad'",
						validate_msg: "Not **bad**",
					},
					{
						uuid: IDS.note,
						kind: "text",
						id: "note",
						label: "Note",
						help_media: { image: IDS.helpImage },
					},
					{
						uuid: IDS.choice,
						kind: "single_select",
						id: "choice",
						label: "Choice",
						options: [
							{ value: "yes", label: "**Bold** yes" },
							{ value: "no", label: "No" },
						],
					},
					{
						kind: "group",
						id: "details",
						label: "Details",
						children: [{ kind: "text", id: "inside", label: "Inside" }],
					},
					/* The image in the label is drawn only where the label renders
					 * images, which Android does not; Web Apps never sees it. */
					...(platform === "android"
						? [
								{
									kind: "label" as const,
									id: "markdown",
									label: MARKDOWN_LABEL_TEXT,
								},
							]
						: []),
				]),
			];
		case "sections":
			return [
				{
					kind: "section",
					id: "about",
					label: "About you",
					children: [
						{
							uuid: IDS.name,
							kind: "text",
							id: "name",
							label: "Name",
							required: "true()",
						},
					],
				},
				{
					kind: "section",
					id: "visit",
					label: "Your visit",
					children: [
						{ uuid: IDS.note, kind: "text", id: "note", label: "Note" },
					],
				},
			];
		case "screens":
			return [
				{
					uuid: IDS.name,
					kind: "text",
					id: "name",
					label: "Name",
					required: "true()",
				},
				{
					kind: "repeat",
					id: "visits",
					label: "Visits",
					repeat_mode: "user_controlled",
					children: [
						{
							kind: "group",
							id: "details",
							label: "Details",
							children: [{ kind: "text", id: "note", label: "Note" }],
						},
					],
				},
				/* Everything after the repeat hides for the name Quick, so the
				 * repeat prompt then has nothing after it. The group is
				 * unlabeled (below), so it is transparent to Android's screens. */
				{
					kind: "group",
					id: "rest",
					relevant: "/data/name != 'Quick'",
					children: [
						{
							kind: "group",
							id: "household",
							label: "Household",
							children: [
								{ kind: "text", id: "adults", label: "Adults" },
								{ kind: "text", id: "children", label: "Children" },
							],
						},
						{
							kind: "group",
							id: "extras",
							children: [
								{ kind: "text", id: "first_extra", label: "First extra" },
								{ kind: "text", id: "second_extra", label: "Second extra" },
							],
						},
						{
							kind: "group",
							id: "stock",
							label: "Stock",
							children: [
								{
									kind: "repeat",
									id: "items",
									label: "Items",
									repeat_mode: "user_controlled",
									children: [{ kind: "text", id: "item", label: "Item" }],
								},
							],
						},
						{ kind: "text", id: "wrap_up", label: "Wrap up" },
					],
				},
			];
		case "media":
			return [
				inSection("Media", [
					{ uuid: IDS.image, kind: "image", id: "photo", label: "Photo" },
					{ kind: "audio", id: "voice", label: "Voice" },
					{ kind: "video", id: "clip", label: "Clip" },
					{
						uuid: IDS.choice,
						kind: "single_select",
						id: "choice",
						label: "Choice",
						options: [
							{
								value: "yes",
								label: "Yes",
								media: { image: IDS.choiceImage },
							},
							{ value: "no", label: "No" },
						],
					},
				]),
			];
		case "home":
			return [{ kind: "text", id: "note", label: "Note" }];
		case "search":
			throw new Error(
				"Search scenarios run in the search peer, preview-search-client.tsx.",
			);
	}
}

const built = buildDoc({
	appId: "native-platforms",
	appName: "Platforms",
	modules: [
		{
			uuid: IDS.module,
			name: "Visits",
			forms: [
				{
					uuid: IDS.form,
					name: "Visit",
					type: "survey",
					fields: fieldsOf(scenario.fixture),
				},
			],
		},
	],
});
if (scenario.fixture === "home") built.logo = IDS.logo;
/* A group's label is optional and the fixture builder gives every group one;
 * the screens fixture's `rest` and `extras` are unlabeled. */
if (scenario.fixture === "screens")
	for (const field of Object.values(built.fields))
		if (
			field.kind === "group" &&
			(field.id === "rest" || field.id === "extras")
		)
			delete field.label;
const doc = admittedControllerDoc(built);
const docStore = createBlueprintDocStore();
docStore.getState().load(doc);
docStore.getState().startTracking();
const session = createBuilderSessionStore({
	appId: doc.appId,
	projectId: "project-a",
	role: "editor",
	canEdit: true,
});
session.getState().setPreviewPlatform(platform);
/* The module list is the screen the home scenario reads, past Android's
 * device home. */
session.getState().setPreviewing(true, { atHome: false });

let controller: EngineController | undefined;
function Capture() {
	const current = useBuilderFormEngine();
	/* The running shell installs the device it plays; this peer mounts the
	 * form screen alone, so it installs it the same way. */
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
pushBuilderHistory(
	scenario.fixture === "home"
		? `/build/${doc.appId}`
		: `/build/${doc.appId}/${IDS.module}/${IDS.form}`,
);
root.render(
	<BuilderSessionContext value={session}>
		<BlueprintDocContext value={docStore}>
			<BuilderLocalizationProvider>
				<BuilderFormEngineProvider>
					<Capture />
					<ScrollRegistryProvider>
						<EditGuardProvider>
							{scenario.fixture === "home" ? (
								<HomeScreen />
							) : (
								<FormScreen
									screen={{
										type: "form",
										moduleUuid: IDS.module,
										formUuid: IDS.form,
									}}
								/>
							)}
						</EditGuardProvider>
					</ScrollRegistryProvider>
				</BuilderFormEngineProvider>
			</BuilderLocalizationProvider>
		</BlueprintDocContext>
	</BuilderSessionContext>,
);
const toasts = document.createElement("div");
document.body.append(toasts);
const toastRoot = createRoot(toasts);
toastRoot.render(<ToastContainer />);

window.previewPlatforms = {
	answer: (uuid) => controller?.store.getState()[uuid]?.value,
	async settled() {
		await controller?.awaitSettled();
	},
	async dispose() {
		const owned = controller;
		root.unmount();
		toastRoot.unmount();
		await owned?.awaitSettled();
		await __resetAttachmentCoordinatorForTests();
	},
};
declare global {
	interface Window {
		previewPlatforms: {
			answer(uuid: string): string | undefined;
			settled(): Promise<void>;
			dispose(): Promise<void>;
		};
	}
}
