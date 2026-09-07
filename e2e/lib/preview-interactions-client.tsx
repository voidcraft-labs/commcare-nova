import { attachClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { testUuid } from "@/__tests__/helpers/uuid";
import { EditGuardProvider } from "@/components/builder/contexts/EditGuardContext";
import { TextEditable } from "@/components/preview/form/TextEditable";
import { DropPlaceholderRow } from "@/components/preview/form/virtual/DropPlaceholderRow";
import { makeDropFieldData } from "@/components/preview/form/virtual/dragData";
import { buildFormRows } from "@/components/preview/form/virtual/rowModel";
import { useDragIntent } from "@/components/preview/form/virtual/useDragIntent";
import { useRowDnd } from "@/components/preview/form/virtual/useRowDnd";
import { ScreenNavButtons } from "@/components/preview/ScreenNavButtons";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import {
	blueprintDocSchema,
	type CommitOutcome,
	type ProseTemplate,
	proseText,
	type Uuid,
} from "@/lib/domain";
import { BuilderSessionProvider } from "@/lib/session/provider";

const FORM = testUuid("native-drag-form");
const MODULE = testUuid("native-drag-module");
const ids = ["Alpha", "Beta", "Gamma"].map((name) => testUuid(name));
const doc = buildDoc({
	modules: [
		{
			uuid: MODULE,
			name: "Native controls",
			forms: [
				{
					uuid: FORM,
					name: "Visit",
					type: "survey",
					fields: ids.map((uuid, index) =>
						f({
							uuid,
							kind: "text",
							id: `question_${index}`,
							label: proseText(["Alpha", "Beta", "Gamma"][index] ?? "Question"),
						}),
					),
				},
			],
		},
	],
});
blueprintDocSchema.parse(toPersistableDoc(doc));
const verdict = mutationCommitVerdict(
	doc,
	[{ kind: "setAppName", name: "Native controls" }],
	LOOKUP_CONTEXT_UNAVAILABLE,
);
if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));
const store = createBlueprintDocStore();
store.getState().load(toPersistableDoc(doc));
window.history.replaceState(
	null,
	"",
	`/build/native-preview/${MODULE}/${FORM}`,
);

function Row({ uuid, index }: { uuid: Uuid; index: number }) {
	const buildDropData = useCallback<
		Parameters<typeof useRowDnd>[0]["buildDropData"]
	>(
		({ input, element }) =>
			attachClosestEdge(makeDropFieldData(uuid, FORM, index), {
				input,
				element,
				allowedEdges: ["top", "bottom"],
			}),
		[uuid, index],
	);
	const { ref } = useRowDnd({
		draggableUuid: uuid,
		cycleTargetContainerUuid: FORM,
		buildDropData,
	});
	const field = store.getState().fields[uuid];
	return (
		<div
			ref={ref}
			data-drag-row={uuid}
			style={{ height: 70, margin: 10, border: "1px solid grey", padding: 15 }}
		>
			Move {field?.id}
		</div>
	);
}
function DragCanvas() {
	const current = useSyncExternalStore(store.subscribe, store.getState);
	const rows = buildFormRows(current, FORM, {
		includeInsertionPoints: true,
		collapsed: new Set(),
	});
	const baseRowsRef = useRef(rows);
	baseRowsRef.current = rows;
	const drag = useDragIntent({ formUuid: FORM, baseRowsRef });
	return (
		<section
			aria-label="Drag canvas"
			data-drag-active={drag.dragActive}
			data-landing-ready={drag.placeholderIndex !== null}
		>
			{current.fieldOrder[FORM].map((uuid, index) => (
				<Row key={uuid} uuid={uuid} index={index} />
			))}
			{drag.placeholderIndex !== null && (
				<div data-native-placeholder>
					<DropPlaceholderRow depth={drag.placeholderDepth} />
				</div>
			)}
		</section>
	);
}
function EditorPair() {
	const [first, setFirst] = useState(proseText("First label"));
	const [second, setSecond] = useState(proseText("Second label"));
	const save = (value: ProseTemplate): CommitOutcome => {
		// This peer controls the documented CommitOutcome boundary. The native
		// test proves draft/focus handling, not the app validator's decisions.
		if (JSON.stringify(value).includes("Rejected"))
			return {
				ok: false,
				messages: ["This draft was refused by the owning editor."],
			};
		setFirst(value);
		return { ok: true };
	};
	return (
		<section aria-label="Text editors" style={{ marginTop: 90 }}>
			<div data-editor="first">
				<TextEditable value={first} onSave={save} fieldType="label">
					{first.parts
						.map((part) => (part.kind === "text" ? part.text : "[reference]"))
						.join("")}
				</TextEditable>
			</div>
			<div data-editor="second">
				<TextEditable
					value={second}
					onSave={(value) => {
						setSecond(value);
						return { ok: true };
					}}
					fieldType="label"
				>
					{second.parts
						.map((part) => (part.kind === "text" ? part.text : "[reference]"))
						.join("")}
				</TextEditable>
			</div>
			<button type="button">Outside editor</button>
		</section>
	);
}
let unmountCanvas: (() => void) | undefined;
function App() {
	const [mounted, setMounted] = useState(true);
	const [backCount, setBackCount] = useState(0);
	unmountCanvas = () => setMounted(false);
	return (
		<BuilderSessionProvider>
			<BlueprintDocContext value={store}>
				<EditGuardProvider>
					<ScreenNavButtons
						canGoBack={backCount === 0}
						onBack={() => setBackCount((n) => n + 1)}
					/>
					<output aria-label="Back activations">{backCount}</output>
					{mounted && <DragCanvas />}
					<EditorPair />
				</EditGuardProvider>
			</BlueprintDocContext>
		</BuilderSessionProvider>
	);
}
const element = document.getElementById("root");
if (element === null) throw new Error("Missing native root");
const root = createRoot(element);
window.previewInteractionsAudit = {
	ids,
	order: () => [...store.getState().fieldOrder[FORM]],
	unmountCanvas: () => unmountCanvas?.(),
	dispose: () => root.unmount(),
};
declare global {
	interface Window {
		previewInteractionsAudit: {
			ids: Uuid[];
			order(): Uuid[];
			unmountCanvas(): void;
			dispose(): void;
		};
	}
}
root.render(<App />);
