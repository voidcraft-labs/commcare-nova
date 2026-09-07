import { type ReactNode, useRef } from "react";
import { createRoot } from "react-dom/client";
import { PersonaRemoveConfirm } from "@/components/builder/app-setup/PersonaRemoveConfirm";
import { EditGuardProvider } from "@/components/builder/contexts/EditGuardContext";
import { ScrollRegistryProvider } from "@/components/builder/contexts/ScrollRegistryContext";
import { PreviewIdentityMenu } from "@/components/builder/PreviewIdentityMenu";
import { useBuilderShortcuts } from "@/components/builder/useBuilderShortcuts";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { evaluateCommit } from "@/lib/commcare/validator/gate";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { usePersonas } from "@/lib/doc/hooks/useUserCollections";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	BlueprintDocProvider,
	BlueprintEditableContext,
} from "@/lib/doc/provider";
import { asUuid, blueprintDocSchema } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import {
	useCanEdit,
	usePreviewing,
	usePreviewPersonaUuid,
	useSetPreviewing,
} from "@/lib/session/hooks";
import {
	BuilderSessionProvider,
	useBuilderSessionApi,
} from "@/lib/session/provider";
import { useKeyboardShortcuts } from "@/lib/ui/hooks/useKeyboardShortcuts";

const personaUuid = asUuid("10000000-0000-4000-8000-000000007100");
const source = {
	...buildDoc({
		appId: "native-session",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: ["first", "second", "third"].map((id, index) => ({
							id,
							uuid: asUuid(`10000000-0000-4000-8000-00000000710${index + 1}`),
							kind: "text" as const,
							label: proseText(id),
						})),
					},
				],
			},
		],
	}),
	personas: { [personaUuid]: { uuid: personaUuid, name: "Asha" } },
	personaOrder: [personaUuid],
};
const admitted = evaluateCommit({
	nextDoc: structuredClone(source),
	lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
});
if (!admitted.ok) throw new Error(JSON.stringify(admitted));
const doc = toPersistableDoc(source);
blueprintDocSchema.parse(doc);
const moduleUuid = source.moduleOrder[0];
const formUuid = source.formOrder[moduleUuid][0];
const first = source.fieldOrder[formUuid][0];
const mode = new URLSearchParams(location.search).get("scenario") ?? "persona";
window.history.replaceState(
	null,
	"",
	`/build/native-session/${formUuid}/${first}`,
);
function AccessBridge({ children }: { children: ReactNode }) {
	const canEdit = useCanEdit();
	return (
		<BlueprintEditableContext value={canEdit}>
			{children}
		</BlueprintEditableContext>
	);
}
function Persona() {
	const personas = usePersonas();
	const returnRef = useRef<HTMLButtonElement>(null);
	const selected = usePreviewPersonaUuid();
	const previewing = usePreviewing();
	const setPreview = useSetPreviewing();
	const mutations = useBlueprintMutations();
	return (
		<>
			<Button ref={returnRef}>Persona list</Button>
			{personas.map((persona) => (
				<PersonaRemoveConfirm
					key={persona.uuid}
					persona={persona}
					returnFocusRef={returnRef}
				/>
			))}
			<Button onClick={() => setPreview(!previewing)}>Toggle Preview</Button>
			<Button onClick={() => mutations.removePersona(personaUuid)}>
				Peer removes persona
			</Button>
			<PreviewIdentityMenu />
			<output aria-label="Saved personas">{JSON.stringify(personas)}</output>
			<output aria-label="Selected persona">{selected ?? "me"}</output>
		</>
	);
}
function Shortcuts() {
	const setPreview = useSetPreviewing();
	const shortcuts = useBuilderShortcuts(setPreview);
	useKeyboardShortcuts("native-builder-shortcuts", shortcuts);
	const session = useBuilderSessionApi();
	const location = useLocation();
	const navigate = useNavigate();
	const fields = useBlueprintDoc((s) => s.fields);
	const order = useBlueprintDoc((s) => s.fieldOrder[formUuid]);
	const previewing = usePreviewing();
	return (
		<>
			<Button onClick={() => navigate.openForm(moduleUuid, formUuid, first)}>
				Select first field
			</Button>
			<Button onClick={() => navigate.openCaseList(moduleUuid)}>
				Case workspace
			</Button>
			<Button
				onClick={() =>
					session.getState().applyAccessSnapshot({
						projectId: "native-project",
						role: "viewer",
						canEdit: false,
					})
				}
			>
				Viewer access
			</Button>
			<Button onClick={() => session.getState().beginAccessRefresh()}>
				Refresh access
			</Button>
			<Input aria-label="Local input" />
			<Button>Native Tab target</Button>
			<section tabIndex={-1} aria-label="Shortcut canvas">
				Keyboard canvas
			</section>
			<output aria-label="Selected location">{JSON.stringify(location)}</output>
			<output aria-label="Saved fields">
				{JSON.stringify(order.map((uuid) => ({ uuid, id: fields[uuid]?.id })))}
			</output>
			<output aria-label="Preview active">{String(previewing)}</output>
		</>
	);
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
	<BlueprintDocProvider initialDoc={doc} appId="native-session" canEdit>
		<BuilderSessionProvider
			init={{
				appId: "native-session",
				projectId: "native-project",
				role: "editor",
				canEdit: true,
			}}
		>
			<AccessBridge>
				<ScrollRegistryProvider>
					<EditGuardProvider>
						{mode === "shortcuts" ? <Shortcuts /> : <Persona />}
					</EditGuardProvider>
				</ScrollRegistryProvider>
			</AccessBridge>
		</BuilderSessionProvider>
	</BlueprintDocProvider>,
);
