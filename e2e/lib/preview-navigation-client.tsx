import { createRoot } from "react-dom/client";
import { BuilderLocalizationProvider } from "@/components/builder/localization/BuilderLocalizationProvider";
import { PreviewShell } from "@/components/preview/PreviewShell";
import { TooltipProvider } from "@/components/shadcn/tooltip";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Platform } from "@/lib/domain/platforms";
import { admittedControllerDoc } from "@/lib/preview/engine/__tests__/fixtures/controllerDoc";
import { BuilderFormEngineProvider } from "@/lib/preview/engine/provider";
import { useLocation } from "@/lib/routing/hooks";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";
import {
	usePreviewAtDeviceHome,
	usePreviewSessionId,
} from "@/lib/session/hooks";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";
import { buildNavigationDoc } from "./previewNavigationFixture";

/**
 * The component peer of `preview-platforms.spec.ts`'s navigation tests: the
 * running app's menus over two cases the worker's device holds, in an app
 * that runs in Web Apps and on Android, played as `?platform=`.
 *
 * - `?fixture=search-first`: a case-first menu with one Search field and no
 *   saved workflow, so it searches first.
 * - `?fixture=case-list-entry`: a forms-first menu (a registration form
 *   beside a follow-up) that lists its case list as an entry of its own
 *   after its forms. `?details` gives the case list a Details screen.
 * - `?fixture=case-first-entry`: a case-first menu (one follow-up) that
 *   holds its case list as an entry of its own.
 * - `?fixture=child-list-above`: a case-first menu of households and a
 *   menu of their members showing its follow-up and its case list entry
 *   there.
 * - `?fixture=submenus`: a case-first menu of households and a menu that is
 *   only their case list, each keeping a submenu with a screen of its own.
 * - `?fixture=parent-chain`: villages, their households and the
 *   households' people, each chosen under the one before it.
 * - `?fixture=place-condition`: "Patients" beside a menu whose condition
 *   reads the worker's place, for a worker assigned nowhere.
 * - `?fixture=place-screens`: a submenu, a case-first menu's form and a
 *   Search field that each read that place, under a first menu that reads
 *   nothing of it.
 */

const params = new URLSearchParams(location.search);
const fixture = params.get("fixture");
const platform = params.get("platform") as Platform | null;
if (
	fixture !== "search-first" &&
	fixture !== "case-list-entry" &&
	fixture !== "case-first-entry" &&
	fixture !== "child-list-above" &&
	fixture !== "submenus" &&
	fixture !== "parent-chain" &&
	fixture !== "place-condition" &&
	fixture !== "place-screens"
)
	throw new Error(`No navigation fixture named ${String(fixture)}.`);
if (platform !== "web-apps" && platform !== "android")
	throw new Error(`No platform named ${String(platform)}.`);
const withDetails = params.has("details");

const source = buildNavigationDoc(fixture, withDetails);
// Construction runs the actual strict schema and semantic admission.
const doc = admittedControllerDoc(source);
const docStore = createBlueprintDocStore();
docStore.getState().load(doc);
const session = createBuilderSessionStore({
	appId: doc.appId,
	projectId: "project-navigation",
	role: "editor",
	canEdit: true,
});
session.getState()._setDocStore(docStore);
session.getState().setPreviewPlatform(platform);
/* The app's module list, past Android's device home. */
session.getState().setPreviewing(true, { atHome: false });

function Observed() {
	const where = useLocation();
	const atDeviceHome = usePreviewAtDeviceHome();
	const sessionId = usePreviewSessionId();
	return (
		<>
			<output aria-label="Location">{where.kind}</output>
			<output aria-label="At the device home">{String(atDeviceHome)}</output>
			<output aria-label="Preview session">{sessionId}</output>
		</>
	);
}

const element = document.getElementById("root");
if (!element) throw new Error("Missing navigation root");
element.style.height = "calc(100vh - 32px)";
const root = createRoot(element);
pushBuilderHistory(`/build/${doc.appId}`);
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

/* `go` moves the running app to a builder address as the app's own links
 * do (`pushBuilderHistory`), so a spec can name a case in a list's address
 * while a selection is under way. */
window.previewNavigation = {
	dispose: () => root.unmount(),
	go: (path: string) => pushBuilderHistory(path),
};
declare global {
	interface Window {
		previewNavigation: { dispose(): void; go(path: string): void };
	}
}
