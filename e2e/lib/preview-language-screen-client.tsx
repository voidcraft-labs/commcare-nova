import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	BuilderLocalizationProvider,
	useBuilderLanguage,
} from "@/components/builder/localization/BuilderLocalizationProvider";
import {
	__resetAttachmentCoordinatorForTests,
	getAttachmentSlotPath,
	getOwnedStagedAttachment,
	runFormAttachmentBarrier,
} from "@/components/preview/form/fields/attachment/attachmentClient";
import { FormScreen } from "@/components/preview/screens/FormScreen";
import {
	removeSectionKeepingQuestions,
	splitIntoSections,
} from "@/lib/doc/formSectionMutations";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { proseText } from "@/lib/domain/prose";
import { applyControllerEdit } from "@/lib/preview/engine/__tests__/fixtures/controllerDoc";
import type { EngineController } from "@/lib/preview/engine/engineController";
import {
	BuilderFormEngineProvider,
	useBuilderFormEngine,
} from "@/lib/preview/engine/provider";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";
import {
	CLOCK,
	DATE,
	FORM,
	GREETING,
	IMAGE,
	languageScreenDoc,
	MODULE,
	NAME,
	NOTE,
	POINT,
	REPEAT,
	SECTION,
	SIGNATURE,
} from "./preview-language-screen-doc";
import {
	armLanguageWorker,
	languageWorkerHeld,
	languageWorkerObservation,
	observeLanguageWorkerEntry,
	releaseLanguageWorker,
} from "./preview-language-worker-boundary";

const doc = languageScreenDoc();
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
const entryPublications: unknown[] = [];
function LanguageControls() {
	const current = useBuilderFormEngine();
	const language = useBuilderLanguage();
	useEffect(() => {
		controller = current;
		observeLanguageWorkerEntry(current.entryStore.getState());
		const unsubscribe = current.entryStore.subscribe((state) => {
			entryPublications.push(state);
			observeLanguageWorkerEntry(state);
		});
		return () => {
			unsubscribe();
			controller = undefined;
		};
	}, [current]);
	return (
		<div className="flex gap-2 pb-4">
			<button type="button" onClick={() => language.selectLanguage("eng")}>
				English
			</button>
			<button type="button" onClick={() => language.selectLanguage("spa")}>
				Español
			</button>
		</div>
	);
}
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
					<LanguageControls />
					<FormScreen
						screen={{ type: "form", moduleUuid: MODULE, formUuid: FORM }}
					/>
				</BuilderFormEngineProvider>
			</BuilderLocalizationProvider>
		</BlueprintDocContext>
	</BuilderSessionContext>,
);

window.previewLanguageScreen = {
	arm: armLanguageWorker,
	held: languageWorkerHeld,
	release: releaseLanguageWorker,
	rename() {
		applyControllerEdit(docStore, [
			{
				kind: "updateField",
				uuid: SECTION,
				targetKind: "section",
				patch: { id: "encounter" },
			},
			{
				kind: "updateField",
				uuid: REPEAT,
				targetKind: "repeat",
				patch: { id: "journeys" },
			},
			{
				kind: "updateField",
				uuid: NOTE,
				targetKind: "text",
				patch: { id: "detail" },
			},
			{
				kind: "updateField",
				uuid: SIGNATURE,
				targetKind: "signature",
				patch: { id: "approval" },
			},
			{
				kind: "updateField",
				uuid: IMAGE,
				targetKind: "image",
				patch: { id: "evidence" },
			},
		]);
	},
	unwrap() {
		const plan = removeSectionKeepingQuestions(docStore.getState(), SECTION);
		if (!plan.ok) throw new Error(plan.reason);
		applyControllerEdit(docStore, plan.mutations);
	},
	wrap() {
		const plan = splitIntoSections(docStore.getState(), FORM, {
			sectionUuids: [testUuid("language-screen-rewrapped-section")],
			titles: [proseText("Wrapped visit")],
		});
		if (!plan.ok) throw new Error(plan.reason);
		applyControllerEdit(docStore, plan.mutations);
	},
	observation() {
		const state = controller?.store.getState();
		const presentation = controller?.presentationDocument;
		const repeatPath = controller?.getPath(REPEAT);
		const notePath =
			repeatPath === undefined
				? undefined
				: `${repeatPath}[0]/${presentation?.fields[NOTE].id}`;
		const imagePath =
			repeatPath === undefined
				? undefined
				: `${repeatPath}[0]/${presentation?.fields[IMAGE].id}`;
		const entryKey = controller?.entryKey;
		const instanceKey = controller?.getRepeatInstanceKey(REPEAT, 0, repeatPath);
		const slotKey = `${IMAGE}\u0000\u0000${REPEAT}:${instanceKey}`;
		const coordinates = { appId: doc.appId, entryKey: entryKey ?? "", slotKey };
		const rootUuid = presentation?.fieldOrder[FORM]?.[0];
		const rootField =
			rootUuid === undefined ? undefined : presentation?.fields[rootUuid];
		return {
			entry: controller?.entryStore.getState(),
			entryPublications,
			worker: languageWorkerObservation(),
			values: {
				name: state?.[NAME]?.value,
				date: state?.[DATE]?.value,
				when: state?.[CLOCK]?.value,
				location: state?.[POINT]?.value,
				note: notePath === undefined ? undefined : state?.[notePath]?.value,
			},
			paths: { repeat: repeatPath, note: notePath, image: imagePath },
			topology: {
				sectioned: rootField?.kind === "section",
				rootUuid,
				pages: controller
					?.sectionPages()
					.map((page) => ({ uuid: page.uuid, path: page.path })),
			},
			capture: {
				value: imagePath === undefined ? undefined : state?.[imagePath]?.value,
				owned: getOwnedStagedAttachment(coordinates),
				slotPath: getAttachmentSlotPath(coordinates),
			},
			greeting: state?.[GREETING]?.resolvedLabel,
			repeatKeys: [0, 1].map((index) =>
				controller?.getRepeatInstanceKey(REPEAT, index, repeatPath),
			),
		};
	},
	async settled() {
		await controller?.awaitSettled();
	},
	async captureSettled() {
		await controller?.awaitSettled();
		const entryKey = controller?.entryKey;
		if (entryKey !== undefined)
			await runFormAttachmentBarrier(entryKey, async () => {});
	},
	async newEntry() {
		await controller?.activateFormAsync(FORM);
	},
	async dispose() {
		const owned = controller;
		root.unmount();
		releaseLanguageWorker();
		await owned?.awaitSettled();
		await __resetAttachmentCoordinatorForTests();
	},
};
declare global {
	interface Window {
		previewLanguageScreen: {
			arm(): void;
			held(): boolean;
			release(): void;
			rename(): void;
			unwrap(): void;
			wrap(): void;
			observation(): {
				entry:
					| import("@/lib/preview/engine/engineController").EngineEntryState
					| undefined;
				entryPublications: unknown[];
				worker: ReturnType<typeof languageWorkerObservation>;
				values: {
					name: string | undefined;
					date: string | undefined;
					when: string | undefined;
					location: string | undefined;
					note: string | undefined;
				};
				greeting: string | undefined;
				paths: {
					repeat: string | undefined;
					note: string | undefined;
					image: string | undefined;
				};
				capture: {
					value: string | undefined;
					owned:
						| import("@/components/preview/form/fields/attachment/attachmentClient").StagedAttachment
						| undefined;
					slotPath: string | undefined;
				};
				topology: {
					sectioned: boolean;
					rootUuid: import("@/lib/domain").Uuid | undefined;
					pages:
						| { uuid: import("@/lib/domain").Uuid; path: string }[]
						| undefined;
				};
				repeatKeys: (string | undefined)[];
			};
			settled(): Promise<void>;
			captureSettled(): Promise<void>;
			newEntry(): Promise<void>;
			dispose(): Promise<void>;
		};
	}
}
