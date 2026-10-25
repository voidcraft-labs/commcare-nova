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
import { plainColumn, proseText, simpleSearchInputDef } from "@/lib/domain";
import { admittedControllerDoc } from "@/lib/preview/engine/__tests__/fixtures/controllerDoc";
import {
	previewAsMe,
	previewSessionValues,
} from "@/lib/preview/engine/identity";
import { serverPreviewDevice } from "@/lib/preview/engine/previewDevice";
import { useSearchInputRunState } from "@/lib/preview/hooks/useSearchInputRunState";
import {
	previewPlatformRules,
	searchScreenHeading,
} from "@/lib/preview/platform";

const languageJourney = new URLSearchParams(window.location.search).has(
	"language",
);
/* `?platform=android` plays Android's search screen (the barcode field
 * scans, no hints, the search action's label as the heading); `?platform=
 * web-apps` plays Web Apps'. Either names the screen's title, description
 * and a hint on the name field; without it the form plays an app that runs
 * on both, with no heading. */
const platformParam = new URLSearchParams(window.location.search).get(
	"platform",
);
const platform =
	platformParam === "android" || platformParam === "web-apps"
		? platformParam
		: undefined;
const platformRules =
	platform === undefined ? undefined : previewPlatformRules(platform);

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
		platform === undefined ? undefined : { hint: "First or last name" },
	),
	simpleSearchInputDef(
		testUuid("search-period"),
		"registered",
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
const moduleUuid = testUuid("native-search-module");
const doc = buildDoc({
	appId: "native-search",
	caseTypes: [caseType],
	modules: [
		{
			uuid: moduleUuid,
			name: "Search",
			caseType: caseType.name,
			caseListConfig: {
				columns: [
					plainColumn(testUuid("native-search-name"), "case_name", "Name"),
				],
				searchInputs: inputs,
			},
			forms: [
				{
					name: "Visit",
					type: "followup",
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
	wireCodes: { eng: "en", spa: "es", "eng-GB": "eng-gb" },
	translations: { spa: {}, "eng-GB": {} },
};
const docStore = createBlueprintDocStore();
docStore.getState().load(admittedControllerDoc(doc));
const environment = { doc, moduleUuid };
const SEARCH_DEVICE = serverPreviewDevice({
	platform: platform ?? "web-apps",
	appLanguage: "en",
});

function SearchHeading({
	rules,
}: {
	rules: Parameters<typeof searchScreenHeading>[0];
}) {
	const { title, subtitle } = searchScreenHeading(rules, {
		title: "Find a patient",
		subtitle: "Search by name or barcode",
	});
	return (
		<header>
			<h1>{title}</h1>
			{subtitle !== undefined && <p>{subtitle}</p>}
		</header>
	);
}

function Surface({ revision }: { revision: number }) {
	const { selectLanguage } = useBuilderLanguage();
	const [authoringDate, setAuthoringDate] = useState("2024-01-15");
	const run = useSearchInputRunState({
		scopeKey: "native-search",
		searchInputs: inputs,
		environment,
		session: previewSessionValues(
			previewAsMe({
				id: "worker",
				name: "Worker",
				email: "worker@example.org",
			}),
			SEARCH_DEVICE,
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
			{platformRules !== undefined && <SearchHeading rules={platformRules} />}
			<SearchInputForm
				platformRules={platformRules}
				caseType={caseType}
				searchInputs={inputs}
				environment={environment}
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
