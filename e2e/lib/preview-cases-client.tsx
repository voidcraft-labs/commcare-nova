import { useState } from "react";
import { createRoot } from "react-dom/client";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BuilderLocalizationProvider } from "@/components/builder/localization/BuilderLocalizationProvider";
import { CaseListScreen } from "@/components/preview/screens/CaseListScreen";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import {
	calculatedColumn,
	phoneColumn,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
import { admittedControllerDoc } from "@/lib/preview/engine/__tests__/fixtures/controllerDoc";
import { BuilderFormEngineProvider } from "@/lib/preview/engine/provider";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";
import {
	configureSeveralCasePopulation,
	unavailableColumnUuid,
} from "./preview-cases-boundary";

const moduleUuid = testUuid("native-cases-module");
export const longModuleName =
	"CommunityFollowUpAndMedicationAdministrationResultsForTheNorthernServiceArea";
export const longFormName =
	"CompleteTheCommunityFollowUpAndMedicationReconciliationWorkflow";
function fixture(count: number) {
	const columns = [
		plainColumn(testUuid("native-case-name"), "case_name", "Name"),
		phoneColumn(testUuid("native-case-phone"), "phone", "Phone"),
		calculatedColumn(unavailableColumnUuid, "Status", term(literal(""))),
		...Array.from({ length: Math.max(0, count - 3) }, (_, index) =>
			plainColumn(
				testUuid(`native-case-column-${index + 4}`),
				`field_${index + 4}`,
				`Field ${index + 4}`,
			),
		),
	];
	return admittedControllerDoc(
		buildDoc({
			appId: "native-cases",
			appName: "Case layout",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "phone", label: proseText("Phone"), data_type: "text" },
						...Array.from({ length: 4 }, (_, index) => ({
							name: `field_${index + 4}`,
							label: proseText(`Field ${index + 4}`),
							data_type: "text" as const,
						})),
					],
				},
			],
			modules: [
				{
					uuid: moduleUuid,
					name: longModuleName,
					caseType: "patient",
					caseListConfig: {
						columns,
						searchInputs: [],
						...(count < 0
							? { selection: { kind: "multiple" as const, maximum: 3 } }
							: {}),
					},
					forms: [
						{
							name: longFormName,
							type: "followup",
							fields: [{ kind: "text", id: "notes", label: "Notes" }],
						},
						{
							name: "Close case",
							type: "close",
							fields: [{ kind: "text", id: "notes", label: "Notes" }],
						},
					],
				},
			],
		}),
	);
}
const session = createBuilderSessionStore({
	appId: "native-cases",
	projectId: "native-project",
	role: "editor",
	canEdit: true,
});
session.getState().setPreviewing(true);
let setCount: (count: number) => void = () => {
	throw new Error("Case layout is not mounted");
};
function Surface() {
	const [count, updateCount] = useState(3);
	setCount = updateCount;
	return (
		<BuilderSessionContext value={session}>
			<BlueprintDocProvider
				key={count}
				appId="native-cases"
				initialDoc={fixture(count)}
			>
				<BuilderLocalizationProvider>
					<BuilderFormEngineProvider>
						<CaseListScreen screen={{ type: "caseList", moduleUuid }} />
					</BuilderFormEngineProvider>
				</BuilderLocalizationProvider>
			</BlueprintDocProvider>
		</BuilderSessionContext>
	);
}
const element = document.getElementById("root");
if (!element) throw new Error("Missing root");
element.style.maxWidth = "1200px";
element.style.padding = "0";
const root = createRoot(element);
pushBuilderHistory(`/build/native-cases/${moduleUuid}/results`);
root.render(<Surface />);
window.previewCasesAudit = {
	setCount,
	several() {
		configureSeveralCasePopulation();
		setCount(-1);
	},
	target: () => session.getState().previewCaseTarget,
	refresh() {
		session.getState().beginAccessRefresh();
		session.getState().resetProjectScope();
		session.getState().applyAccessSnapshot({
			projectId: "next-project",
			role: "editor",
			canEdit: true,
		});
	},
	dispose: () => root.unmount(),
};
// Call the current React setter after the first render commits.
window.previewCasesAudit.setCount = (count) => setCount(count);
declare global {
	interface Window {
		previewCasesAudit: {
			setCount(count: number): void;
			several(): void;
			target(): import("@/lib/session/types").PreviewCaseTarget | undefined;
			refresh(): void;
			dispose(): void;
		};
	}
}
