import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { EditGuardProvider } from "@/components/builder/contexts/EditGuardContext";
import { ScrollRegistryProvider } from "@/components/builder/contexts/ScrollRegistryContext";
import { PreviewIdentityMenu } from "@/components/builder/PreviewIdentityMenu";
import { Button } from "@/components/shadcn/button";
import { ToastContainer } from "@/components/ui/ToastContainer";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	BlueprintDocProvider,
	BlueprintEditableContext,
} from "@/lib/doc/provider";
import { NEW_APP_SETTINGS } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { useCaseDataRevision } from "@/lib/preview/hooks/caseDataInvalidation";
import { useLocation } from "@/lib/routing/hooks";
import {
	useCanEdit,
	usePreviewAtDeviceHome,
	usePreviewing,
	usePreviewPlatform,
	useSetPreviewing,
} from "@/lib/session/hooks";
import { BuilderSessionProvider } from "@/lib/session/provider";

/* `?runs-on=android`: an app that runs only on Android; otherwise one that
 * runs on both. The identity menu chooses Preview's platform under Runs on.
 * The Patients case list gives the app a case type, so releasing a worker's
 * claims has rows to announce changed. */
const androidOnly =
	new URLSearchParams(location.search).get("runs-on") === "android";
const source = buildDoc({
	appId: "native-identity-menu",
	appSettings: androidOnly
		? { ...NEW_APP_SETTINGS, runsOnlyOn: "android" }
		: { ...NEW_APP_SETTINGS },
	modules: [
		{
			name: "Visits",
			forms: [
				{
					name: "Visit",
					type: "survey",
					fields: [{ id: "note", kind: "text", label: proseText("Note") }],
				},
			],
		},
		{
			name: "Patients",
			caseType: "patient",
			caseListMenuItem: {},
			caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
			forms: [],
		},
	],
	caseTypes: [{ name: "patient", properties: [] }],
});
const doc = toPersistableDoc(source);
const moduleUuid = source.moduleOrder[0];
const formUuid = source.formOrder[moduleUuid][0];
/* Preview opens inside a form, so returning to app entry is observable. A
 * form's builder path names the form alone. */
window.history.replaceState(
	null,
	"",
	`/build/native-identity-menu/${formUuid}`,
);

function AccessBridge({ children }: { children: ReactNode }) {
	const canEdit = useCanEdit();
	return (
		<BlueprintEditableContext value={canEdit}>
			{children}
		</BlueprintEditableContext>
	);
}

function Surface() {
	const previewing = usePreviewing();
	const setPreviewing = useSetPreviewing();
	const platform = usePreviewPlatform();
	const atDeviceHome = usePreviewAtDeviceHome();
	const where = useLocation();
	const patientRevision = useCaseDataRevision(
		"native-identity-menu",
		"patient",
	);
	return (
		<>
			<Button onClick={() => setPreviewing(!previewing)}>Toggle Preview</Button>
			<PreviewIdentityMenu />
			<output aria-label="Preview platform">{platform}</output>
			<output aria-label="At the device home">{String(atDeviceHome)}</output>
			<output aria-label="Location">{where.kind}</output>
			<output aria-label="Patient data revision">{patientRevision}</output>
			<ToastContainer />
		</>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
	<BlueprintDocProvider initialDoc={doc} appId="native-identity-menu" canEdit>
		<BuilderSessionProvider
			init={{
				appId: "native-identity-menu",
				projectId: "native-project",
				role: "editor",
				canEdit: true,
			}}
		>
			<AccessBridge>
				<ScrollRegistryProvider>
					<EditGuardProvider>
						<Surface />
					</EditGuardProvider>
				</ScrollRegistryProvider>
			</AccessBridge>
		</BuilderSessionProvider>
	</BlueprintDocProvider>,
);
