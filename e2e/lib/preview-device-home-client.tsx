import { createRoot } from "react-dom/client";
import { BuilderLocalizationProvider } from "@/components/builder/localization/BuilderLocalizationProvider";
import { DeviceHomeScreen } from "@/components/preview/screens/DeviceHomeScreen";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { proseText } from "@/lib/domain/prose";
import { useCaseDataRevision } from "@/lib/preview/hooks/caseDataInvalidation";
import { usePreviewAtDeviceHome } from "@/lib/session/hooks";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";

/* `?saved` and `?incomplete` turn on the app's saved and incomplete forms
 * lists, which Android's home screen shows as buttons. */
const params = new URLSearchParams(location.search);
const doc = buildDoc({
	appId: "native-device-home",
	appName: "Village visits",
	appSettings: {
		showSavedForms: params.has("saved"),
		showIncompleteForms: params.has("incomplete"),
		runsOnlyOn: "android",
	},
	caseTypes: [{ name: "patient", properties: [] }],
	modules: [
		{
			name: "Patients",
			caseType: "patient",
			forms: [
				{
					name: "Visit",
					type: "followup",
					fields: [{ id: "note", kind: "text", label: proseText("Note") }],
				},
			],
		},
	],
});
const docStore = createBlueprintDocStore();
docStore.getState().load(doc);
const session = createBuilderSessionStore({
	appId: doc.appId,
	projectId: "project",
	role: "editor",
	canEdit: true,
});
/* Preview opens on Android at the app's home: the phone's home screen. */
session.getState().setPreviewing(true, { atHome: true });

function Home() {
	const atDeviceHome = usePreviewAtDeviceHome();
	/* Sync with server re-reads the worker's cases by announcing a change to
	 * each case type, as a submission does. */
	const revision = useCaseDataRevision(doc.appId, "patient");
	return (
		<>
			{atDeviceHome ? <DeviceHomeScreen /> : <p>The app's module list</p>}
			<output aria-label="Patient case reads">{revision}</output>
		</>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
	<BuilderSessionContext value={session}>
		<BlueprintDocContext value={docStore}>
			<BuilderLocalizationProvider>
				<Home />
			</BuilderLocalizationProvider>
		</BlueprintDocContext>
	</BuilderSessionContext>,
);
