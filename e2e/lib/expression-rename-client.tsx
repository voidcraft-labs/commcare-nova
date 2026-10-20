import { createRoot } from "react-dom/client";
import { testUuid } from "@/__tests__/helpers/uuid";
import { EditGuardProvider } from "@/components/builder/contexts/EditGuardContext";
import { XPathEditor } from "@/components/builder/editor/fields/XPathEditor";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useFormExpressionText } from "@/lib/doc/hooks/useXPathSlots";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { blueprintDocSchema } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { BuilderSessionProvider } from "@/lib/session/provider";

const ATTENDING = testUuid("rename-attending");
const SHOWN = testUuid("rename-shown");
const OPEN = testUuid("rename-open");
const initial = buildDoc({
	appName: "Renames follow",
	caseTypes: [
		{
			name: "patient",
			properties: [{ name: "status_note", label: "Status note" }],
		},
	],
	modules: [
		{
			name: "Patients",
			caseType: "patient",
			caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
			forms: [
				{
					name: "Visit",
					type: "followup",
					fields: [
						f({
							uuid: ATTENDING,
							id: "a",
							kind: "single_select",
							label: "Attending",
							options: [
								{ uuid: testUuid("rename-yes"), value: "yes", label: "Yes" },
								{ uuid: testUuid("rename-no"), value: "no", label: "No" },
							],
						}),
						f({ uuid: SHOWN, id: "shown", kind: "text", label: "Shown" }),
						f({
							uuid: OPEN,
							id: "open",
							kind: "hidden",
							calculate:
								"count(instance('casedb')/casedb/case[@case_type = 'patient'][status_note = 'x'])",
						}),
					],
				},
			],
		},
	],
});
blueprintDocSchema.parse(toPersistableDoc(initial));
const verdict = mutationCommitVerdict(initial, [], LOOKUP_CONTEXT_UNAVAILABLE);
if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));

function Editors() {
	const shown = useBlueprintDoc((state) => state.fields[SHOWN]);
	const open = useBlueprintDoc((state) => state.fields[OPEN]);
	const mutations = useBlueprintMutations();
	const relevant = "relevant" in shown ? shown.relevant : undefined;
	const calculate = "calculate" in open ? open.calculate : undefined;
	const relevantText = useFormExpressionText(relevant, {
		entity: "field",
		uuid: SHOWN,
		slot: "relevant",
	});
	const calculateText = useFormExpressionText(calculate, {
		entity: "field",
		uuid: OPEN,
		slot: "calculate",
	});
	if (shown.kind !== "text" || open.kind !== "hidden")
		throw new Error("Missing editor fixture");
	return (
		<>
			<section aria-label="Display condition">
				<XPathEditor
					field={shown}
					keyName="relevant"
					label="Show when"
					value={shown.relevant}
					onChange={(value) =>
						mutations.inline.updateField(SHOWN, "text", {
							relevant: value ?? null,
						})
					}
				/>
			</section>
			<section aria-label="Calculated value">
				<XPathEditor
					field={open}
					keyName="calculate"
					label="Open records"
					value={open.calculate}
					onChange={(value) =>
						mutations.inline.updateField(OPEN, "hidden", {
							calculate: value ?? null,
						})
					}
				/>
			</section>
			<button
				type="button"
				onClick={() => mutations.inline.renameField(ATTENDING, "c")}
			>
				Rename the question
			</button>
			<button
				type="button"
				onClick={() =>
					mutations.inline.updateField(ATTENDING, "single_select", {
						label: proseText("Present"),
					})
				}
			>
				Relabel the question
			</button>
			<button
				type="button"
				onClick={() =>
					mutations.inline.renameCaseProperties([
						{ caseType: "patient", from: "status_note", to: "note" },
					])
				}
			>
				Rename the property
			</button>
			<output aria-label="Saved condition">{relevantText}</output>
			<output aria-label="Saved calculation">{calculateText}</output>
		</>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing native editor root");
createRoot(root).render(
	<BlueprintDocProvider initialDoc={toPersistableDoc(initial)}>
		<BuilderSessionProvider>
			<EditGuardProvider>
				<Editors />
			</EditGuardProvider>
		</BuilderSessionProvider>
	</BlueprintDocProvider>,
);
