import { createRoot } from "react-dom/client";
import { testUuid } from "@/__tests__/helpers/uuid";
import { SearchInputForm } from "@/components/preview/shared/SearchInputForm";
import { proseText, simpleSearchInputDef } from "@/lib/domain";
import {
	previewAsMe,
	previewSessionValues,
} from "@/lib/preview/engine/identity";
import { useSearchInputRunState } from "@/lib/preview/hooks/useSearchInputRunState";

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
root.render(<Surface revision={revision} />);
window.previewSearchAudit = {
	rerender() {
		root.render(<Surface revision={++revision} />);
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
