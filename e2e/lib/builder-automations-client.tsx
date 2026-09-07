import { createRoot } from "react-dom/client";
import { AutomationsSection } from "@/components/builder/app-setup/AutomationsSection";
import {
	newAlert,
	newCaseUpdate,
} from "@/components/builder/app-setup/automationEditorModel";
import { Button } from "@/components/shadcn/button";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { evaluateCommit } from "@/lib/commcare/validator/gate";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { useAutomations } from "@/lib/doc/hooks/useAutomationCollections";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { asUuid, blueprintDocSchema } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { BuilderSessionProvider } from "@/lib/session/provider";

const caseUpdate = { ...newCaseUpdate("visit"), name: "Close resolved visits" };
const alert = { ...newAlert("visit"), name: "Send follow-up" };
const source = {
	...buildDoc({
		appName: "Care",
		caseTypes: [
			{
				name: "visit",
				properties: [
					{ name: "state", data_type: "text", label: proseText("State") },
					{ name: "phone", data_type: "text", label: proseText("Phone") },
				],
			},
		],
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Follow up",
						type: "followup",
						fields: [{ id: "state", kind: "text", label: proseText("State") }],
					},
				],
			},
		],
	}),
	automations: { [caseUpdate.uuid]: caseUpdate, [alert.uuid]: alert },
	automationOrder: [caseUpdate.uuid, alert.uuid],
	userProperties: {
		[asUuid("10000000-0000-4000-8000-000000006900")]: {
			uuid: asUuid("10000000-0000-4000-8000-000000006900"),
			label: "Region",
			slug: "region",
		},
	},
	userPropertyOrder: [asUuid("10000000-0000-4000-8000-000000006900")],
};
const admission = evaluateCommit({
	nextDoc: structuredClone(source),
	lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
});
if (!admission.ok) throw new Error(JSON.stringify(admission));
const doc = toPersistableDoc(source);
blueprintDocSchema.parse(doc);
function Content() {
	const automations = useAutomations();
	const mutations = useBlueprintMutations();
	return (
		<>
			<AutomationsSection />
			<Button
				onMouseDown={(e) => e.preventDefault()}
				onClick={() => {
					const current = automations.find((a) => a.uuid === caseUpdate.uuid);
					if (current)
						mutations.inline.replaceAutomation({
							...current,
							name: "Peer changed this",
						});
				}}
			>
				Peer renames rule
			</Button>
			<Button
				onMouseDown={(e) => e.preventDefault()}
				onClick={() => mutations.inline.removeAutomation(caseUpdate.uuid)}
			>
				Peer removes rule
			</Button>
			<output aria-label="Saved automations">
				{JSON.stringify(automations)}
			</output>
		</>
	);
}
const canEdit = new URLSearchParams(location.search).get("viewer") !== "true";
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
	<BlueprintDocProvider
		initialDoc={doc}
		appId="native-automations"
		canEdit={canEdit}
	>
		<BuilderSessionProvider init={{ appId: "native-automations", canEdit }}>
			<Content />
		</BuilderSessionProvider>
	</BlueprintDocProvider>,
);
