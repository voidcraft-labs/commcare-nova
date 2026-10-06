import { useState } from "react";
import { createRoot } from "react-dom/client";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	BuilderLocalizationProvider,
	useBuilderLanguage,
} from "@/components/builder/localization/BuilderLocalizationProvider";
import { SearchInputForm } from "@/components/preview/shared/SearchInputForm";
import { DatePicker } from "@/components/shadcn/date-picker";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { proseText, simpleSearchInputDef } from "@/lib/domain";
import { admittedControllerDoc } from "@/lib/preview/engine/__tests__/fixtures/controllerDoc";
import {
	previewAsMe,
	previewSessionValues,
} from "@/lib/preview/engine/identity";
import { useSearchInputRunState } from "@/lib/preview/hooks/useSearchInputRunState";

const doc = buildDoc({
	appId: "native-search",
	modules: [
		{
			name: "Search",
			forms: [
				{
					name: "Visit",
					type: "survey",
					fields: [{ kind: "text", id: "notes", label: "Notes" }],
				},
			],
		},
	],
});
doc.localization = {
	sourceLanguage: "eng",
	defaultLanguage: "eng",
	languageOrder: ["eng", "spa", "eng-GB"],
	translations: { spa: {}, "eng-GB": {} },
};
const docStore = createBlueprintDocStore();
docStore.getState().load(admittedControllerDoc(doc));
const languageJourney = new URLSearchParams(window.location.search).has(
	"language",
);

const inputs = [
	simpleSearchInputDef(
		testUuid("search-barcode"),
		"barcode",
		"Barcode",
		"barcode",
		"barcode",
	),
	simpleSearchInputDef(
		testUuid("search-name"),
		"case_name",
		"Patient name",
		"text",
		"case_name",
	),
	simpleSearchInputDef(
		testUuid("search-period"),
		"period",
		"Registered",
		"date-range",
		"registered",
	),
];
const caseType = {
	name: "patient",
	properties: [
		{
			name: "barcode",
			label: proseText("Barcode"),
			data_type: "text" as const,
		},
		{ name: "case_name", label: proseText("Name"), data_type: "text" as const },
		{
			name: "registered",
			label: proseText("Registered"),
			data_type: "date" as const,
		},
	],
};
function Surface({ revision }: { revision: number }) {
	const { selectLanguage } = useBuilderLanguage();
	const [authoringDate, setAuthoringDate] = useState("2024-01-15");
	const run = useSearchInputRunState({
		scopeKey: "native-search",
		searchInputs: inputs,
		session: previewSessionValues(
			previewAsMe({
				id: "worker",
				name: "Worker",
				email: "worker@example.org",
			}),
		),
	});
	return (
		<main style={{ padding: 12 }} data-render-revision={revision}>
			{languageJourney && (
				<>
					<button type="button" onClick={() => selectLanguage("eng")}>
						English
					</button>
					<button type="button" onClick={() => selectLanguage("spa")}>
						Español
					</button>
					<button type="button" onClick={() => selectLanguage("eng-GB")}>
						English UK
					</button>
					<DatePicker
						aria-label="Authoring date"
						value={authoringDate}
						onValueChange={setAuthoringDate}
					/>
				</>
			)}
			<SearchInputForm
				caseType={caseType}
				searchInputs={inputs}
				value={run.draft}
				onChange={run.changeDraft}
				onSubmit={run.submit}
			/>
			<output aria-label="Submitted search">
				{JSON.stringify(Object.fromEntries(run.submitted))}
			</output>
		</main>
	);
}
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing root");
const root = createRoot(rootElement);
let revision = 0;
function renderSurface() {
	return (
		<BlueprintDocContext value={docStore}>
			<BuilderLocalizationProvider>
				<Surface revision={revision} />
			</BuilderLocalizationProvider>
		</BlueprintDocContext>
	);
}
root.render(renderSurface());
window.previewSearchAudit = {
	rerender() {
		revision += 1;
		root.render(renderSurface());
	},
	dispose() {
		root.unmount();
	},
};
declare global {
	interface Window {
		previewSearchAudit: { rerender(): void; dispose(): void };
	}
}
