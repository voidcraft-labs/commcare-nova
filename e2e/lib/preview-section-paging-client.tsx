import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BuilderLocalizationProvider } from "@/components/builder/localization/BuilderLocalizationProvider";
import { LanguageSelector } from "@/components/builder/localization/LanguageSelector";
import { PreviewShell } from "@/components/preview/PreviewShell";
import { TooltipProvider } from "@/components/shadcn/tooltip";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import {
	collectTranslationUnits,
	makeTranslationUnitId,
	proseText,
} from "@/lib/domain";
import { admittedControllerDoc } from "@/lib/preview/engine/__tests__/fixtures/controllerDoc";
import type {
	EngineController,
	EngineEntryState,
} from "@/lib/preview/engine/engineController";
import {
	BuilderFormEngineProvider,
	useBuilderFormEngine,
} from "@/lib/preview/engine/provider";
import { buildUrl } from "@/lib/routing/location";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";

const MODULE = testUuid("paging-phone-module");
const FORM = testUuid("paging-phone-form");
const START = testUuid("paging-phone-start");
const DETAILS = testUuid("paging-phone-details");
const REVIEW = testUuid("paging-phone-review");
const NOTE = testUuid("paging-phone-note");
const NAME = testUuid("paging-phone-name");
const FINAL_NOTE = testUuid("paging-phone-final-note");

const source = buildDoc({
	appId: "native-section-paging",
	appName: "Visit pages",
	modules: [
		{
			uuid: MODULE,
			name: "Visits",
			forms: [
				{
					uuid: FORM,
					name: "Visit",
					type: "survey",
					postSubmit: "module",
					fields: [
						{
							uuid: START,
							id: "start",
							kind: "section",
							label: "Start",
							children: [
								{ uuid: NOTE, id: "note", kind: "text", label: "Visit note" },
							],
						},
						{
							uuid: DETAILS,
							id: "details",
							kind: "section",
							label: "Details",
							children: [
								{
									uuid: NAME,
									id: "worker_name",
									kind: "text",
									label: "Worker name",
									required: "true()",
								},
							],
						},
						{
							uuid: REVIEW,
							id: "review",
							kind: "section",
							label: "Review",
							children: [
								{
									uuid: FINAL_NOTE,
									id: "final_note",
									kind: "text",
									label: "Review note",
								},
							],
						},
					],
				},
			],
		},
	],
});
const units = collectTranslationUnits(source);
const spanishLabels = [
	[START, "Inicio"],
	[DETAILS, "Datos"],
	[REVIEW, "Revisión"],
	[NOTE, "Nota de la visita"],
	[NAME, "Nombre del trabajador"],
	[FINAL_NOTE, "Nota de revisión"],
] as const;
source.localization = {
	sourceLanguage: "eng",
	defaultLanguage: "eng",
	languageOrder: ["eng", "spa"],
	translations: {
		spa: Object.fromEntries(
			spanishLabels.map(([uuid, text]) => {
				const id = makeTranslationUnitId("field", uuid, "label");
				const unit = units.find((candidate) => candidate.id === id);
				if (!unit)
					throw new Error(`Missing admitted paging translation unit: ${id}`);
				return [
					id,
					{
						value: proseText(text),
						sourceFingerprint: unit.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "eng",
					},
				] as const;
			}),
		),
	},
};
// Construction runs the actual strict schema and semantic admission. A fixture
// refusal must fail the run before any UI result is treated as reproduction.
const doc = admittedControllerDoc(source);
const docStore = createBlueprintDocStore();
docStore.getState().load(doc);
const session = createBuilderSessionStore({
	appId: doc.appId,
	projectId: "project-paging",
	role: "editor",
	canEdit: true,
});
session.getState().setPreviewing(true);
let controller: EngineController | undefined;
const entries: EngineEntryState[] = [];
const retainedBodies = new WeakMap<Element, number>();
let bodySerial = 0;

function Surface() {
	const current = useBuilderFormEngine();
	useEffect(() => {
		controller = current;
		entries.push(current.entryStore.getState());
		const unsubscribe = current.entryStore.subscribe((entry) => {
			entries.push(entry);
		});
		return () => {
			unsubscribe();
			controller = undefined;
		};
	}, [current]);
	return (
		<>
			<div className="pb-4">
				<LanguageSelector />
			</div>
			<PreviewShell />
		</>
	);
}
const element = document.getElementById("root");
if (!element) throw new Error("Missing paging root");
element.style.height = "calc(100vh - 32px)";
const root = createRoot(element);
pushBuilderHistory(
	buildUrl(`/build/${doc.appId}`, {
		kind: "form",
		moduleUuid: MODULE,
		formUuid: FORM,
	}),
);
root.render(
	<TooltipProvider>
		<BuilderSessionContext value={session}>
			<BlueprintDocContext value={docStore}>
				<BuilderLocalizationProvider>
					<BuilderFormEngineProvider>
						<Surface />
					</BuilderFormEngineProvider>
				</BuilderLocalizationProvider>
			</BlueprintDocContext>
		</BuilderSessionContext>
	</TooltipProvider>,
);

window.sectionPagingAudit = {
	observation: () => {
		// Observe the real FormScreen body outside its entry-keyed fieldset.
		// Identity is read-only evidence of DOM retention, not a routing trigger.
		const body = document.querySelector("[data-preview-engine-state]");
		if (body && !retainedBodies.has(body))
			retainedBodies.set(body, ++bodySerial);
		return {
			entry: controller?.entryStore.getState(),
			entries,
			activeSection: session.getState().getActiveSection(FORM),
			values: {
				note: controller?.store.getState()[NOTE]?.value,
				name: controller?.store.getState()[NAME]?.value,
			},
			document: JSON.stringify(toPersistableDoc(docStore.getState())),
			pathname: window.location.pathname,
			moduleUuid: MODULE,
			formUuid: FORM,
			retainedBodyIdentity: body ? retainedBodies.get(body) : undefined,
		};
	},
	async settled() {
		await controller?.awaitSettled();
	},
	async dispose() {
		const owned = controller;
		root.unmount();
		await owned?.awaitSettled();
	},
};

declare global {
	interface Window {
		sectionPagingAudit: {
			observation(): {
				entry: EngineEntryState | undefined;
				entries: EngineEntryState[];
				activeSection: string | undefined;
				values: { note: string | undefined; name: string | undefined };
				document: string;
				pathname: string;
				moduleUuid: string;
				formUuid: string;
				retainedBodyIdentity: number | undefined;
			};
			settled(): Promise<void>;
			dispose(): Promise<void>;
		};
	}
}
