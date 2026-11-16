import { createRoot } from "react-dom/client";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BuilderLocalizationProvider } from "@/components/builder/localization/BuilderLocalizationProvider";
import { PreviewShell } from "@/components/preview/PreviewShell";
import { TooltipProvider } from "@/components/shadcn/tooltip";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { admittedControllerDoc } from "@/lib/preview/engine/__tests__/fixtures/controllerDoc";
import { BuilderFormEngineProvider } from "@/lib/preview/engine/provider";
import { useLocation } from "@/lib/routing/hooks";
import { buildUrl } from "@/lib/routing/location";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";

/**
 * The component peer of `preview-refusal-backstop.spec.ts`: the real
 * PreviewShell, home and module screens, session and controller, opened on a
 * form whose screen (`preview-refusal-backstop-form.ts`, aliased in place of
 * FormScreen) throws Core's data refusal as it renders while Preview runs
 * the app. What the page shows is the shell's own wiring: the scope it puts
 * the form screen in, the Back it gives that scope, and the mode it retries
 * on. `?refusal=` names the refusal (`form`, `links` or `core-path`).
 */

const MODULE = testUuid("backstop-module");
const FORM = testUuid("backstop-form");

const source = buildDoc({
	appId: "native-refusal-backstop",
	appName: "Visits",
	modules: [
		{
			uuid: MODULE,
			name: "Visits",
			forms: [
				{
					uuid: FORM,
					name: "Visit",
					type: "survey",
					fields: [
						{
							uuid: testUuid("backstop-note"),
							id: "note",
							kind: "text",
							label: "Visit note",
						},
					],
				},
			],
		},
	],
});
// Construction runs the actual strict schema and semantic admission.
const doc = admittedControllerDoc(source);
const docStore = createBlueprintDocStore();
docStore.getState().load(doc);
const session = createBuilderSessionStore({
	appId: doc.appId,
	projectId: "project-refusal-backstop",
	role: "editor",
	canEdit: true,
});
session.getState()._setDocStore(docStore);
session.getState().setPreviewPlatform("web-apps");
session.getState().setPreviewing(true, { atHome: false });

function Observed() {
	const where = useLocation();
	return <output aria-label="Location">{where.kind}</output>;
}

/* The query names the refusal; it is read before the builder URL replaces
 * it, and the form screen reads it from here as it renders. */
const refusal = new URLSearchParams(location.search).get("refusal");
let root: ReturnType<typeof createRoot> | undefined;
window.refusalBackstop = {
	refusal,
	setPreviewing: (on) => session.getState().setPreviewing(on),
	dispose: () => root?.unmount(),
};

const element = document.getElementById("root");
if (!element) throw new Error("Missing refusal backstop root");
element.style.height = "calc(100vh - 32px)";
root = createRoot(element);
pushBuilderHistory(
	buildUrl(`/build/${doc.appId}`, {
		kind: "form",
		moduleUuid: MODULE,
		formUuid: FORM,
	}),
);
root.render(
	<TooltipProvider>
		<BuilderSessionContext value={session}>
			<BlueprintDocContext value={docStore}>
				<BuilderLocalizationProvider>
					<BuilderFormEngineProvider>
						<Observed />
						<PreviewShell />
					</BuilderFormEngineProvider>
				</BuilderLocalizationProvider>
			</BlueprintDocContext>
		</BuilderSessionContext>
	</TooltipProvider>,
);

declare global {
	interface Window {
		refusalBackstop: {
			/** The refusal the form screen throws, from the page's query. */
			readonly refusal: string | null;
			setPreviewing(on: boolean): void;
			dispose(): void;
		};
	}
}
