import { useState } from "react";
import { createRoot } from "react-dom/client";
import { testUuid } from "@/__tests__/helpers/uuid";
import { EditGuardProvider } from "@/components/builder/contexts/EditGuardContext";
import { XPathEditor } from "@/components/builder/editor/fields/XPathEditor";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useXPathText } from "@/lib/doc/hooks/useXPathSlots";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { blueprintDocSchema } from "@/lib/domain";
import { BuilderSessionProvider } from "@/lib/session/provider";

const RESULT = testUuid("codemirror-result");
const initial = buildDoc({
	appName: "Editor evidence",
	modules: [
		{
			name: "Survey",
			forms: [
				{
					name: "Survey",
					type: "survey",
					fields: [
						f({
							uuid: testUuid("codemirror-age"),
							id: "age",
							kind: "int",
							label: "Age",
						}),
						f({ uuid: RESULT, id: "result", kind: "hidden", calculate: "1" }),
						f({
							uuid: testUuid("codemirror-dependent"),
							id: "dependent",
							kind: "hidden",
							calculate: "#form/result",
						}),
					],
				},
			],
		},
	],
});
const wire = toPersistableDoc(initial);
blueprintDocSchema.parse(wire);
const verdict = mutationCommitVerdict(initial, [], LOOKUP_CONTEXT_UNAVAILABLE);
if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));

function Editor() {
	const field = useBlueprintDoc((state) => state.fields[RESULT]);
	const { inline } = useBlueprintMutations();
	const [commits, setCommits] = useState(0);
	const [mounted, setMounted] = useState(true);
	const text = useXPathText("calculate" in field ? field.calculate : undefined);
	if (field.kind !== "hidden") throw new Error("Missing calculated field");
	return (
		<>
			<section aria-label="XPath authoring">
				{mounted && (
					<XPathEditor
						field={field}
						keyName="calculate"
						label="Calculated value"
						value={field.calculate}
						onChange={(value) => {
							const outcome = inline.updateField(RESULT, "hidden", {
								calculate: value ?? null,
							});
							if (outcome.ok) setCommits((count) => count + 1);
							return outcome;
						}}
					/>
				)}
			</section>
			<button type="button">Leave editor</button>
			<button type="button" onClick={() => setMounted(false)}>
				Retire editor
			</button>
			<output aria-label="Saved XPath">{text}</output>
			<output aria-label="Accepted edits">{commits}</output>
		</>
	);
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing native editor root");
createRoot(root).render(
	<BlueprintDocProvider initialDoc={wire}>
		<BuilderSessionProvider>
			<EditGuardProvider>
				<Editor />
			</EditGuardProvider>
		</BuilderSessionProvider>
	</BlueprintDocProvider>,
);
