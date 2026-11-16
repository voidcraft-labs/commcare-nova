import { createRoot } from "react-dom/client";
import { BuilderLocalizationProvider } from "@/components/builder/localization/BuilderLocalizationProvider";
import { PreviewShell } from "@/components/preview/PreviewShell";
import { TooltipProvider } from "@/components/shadcn/tooltip";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { admittedControllerDoc } from "@/lib/preview/engine/__tests__/fixtures/controllerDoc";
import { BuilderFormEngineProvider } from "@/lib/preview/engine/provider";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";
import { releasePreviewIdentity } from "./preview-identity-boundary";
import { buildIdentityDoc } from "./previewIdentityFixture";

/**
 * The component peer of `preview-identity-pending.spec.ts`: the running app
 * of `previewIdentityFixture.ts` in Web Apps, mounted while the signed-in
 * member's session has not resolved, on the app's menus.
 * `window.previewIdentity.release()` resolves it.
 */

// Construction runs the actual strict schema and semantic admission.
const doc = admittedControllerDoc(buildIdentityDoc());
const docStore = createBlueprintDocStore();
docStore.getState().load(doc);
const session = createBuilderSessionStore({
	appId: doc.appId,
	projectId: "project-identity",
	role: "editor",
	canEdit: true,
});
session.getState()._setDocStore(docStore);
session.getState().setPreviewPlatform("web-apps");
session.getState().setPreviewing(true, { atHome: false });

const element = document.getElementById("root");
if (!element) throw new Error("Missing identity root");
element.style.height = "calc(100vh - 32px)";
const root = createRoot(element);
pushBuilderHistory(`/build/${doc.appId}`);
root.render(
	<TooltipProvider>
		<BuilderSessionContext value={session}>
			<BlueprintDocContext value={docStore}>
				<BuilderLocalizationProvider>
					<BuilderFormEngineProvider>
						<PreviewShell />
					</BuilderFormEngineProvider>
				</BuilderLocalizationProvider>
			</BlueprintDocContext>
		</BuilderSessionContext>
	</TooltipProvider>,
);

window.previewIdentity = {
	release: releasePreviewIdentity,
	dispose: () => root.unmount(),
};
declare global {
	interface Window {
		previewIdentity: { release(): void; dispose(): void };
	}
}
