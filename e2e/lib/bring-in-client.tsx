import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { BringInFlow } from "@/components/bring-in/BringInFlow";
import type {
	BringInSeed,
	LandCreatedAppReceipt,
} from "@/components/bring-in/useBringIn";
import { CommCareConnectionProvider } from "@/components/builder/CommCareConnectionContext";
import { useProjectToast } from "@/lib/collab/useProjectToast";
import type { CommCareSettingsPublic } from "@/lib/db/settings";
import { BuilderSessionProvider } from "@/lib/session/provider";

/**
 * What one journey hands the peer, through `page.addInitScript` before the
 * page loads, so a reload of the same page keeps it.
 */
export interface BringInPeerConfig {
	/** The connection the server would hand the page. */
	readonly settings: CommCareSettingsPublic;
	/** The Projects the person may add an app to. */
	readonly projects: BringInSeed["projects"];
	/** The Project the tab is looking at. */
	readonly tabProjectId: string;
	/** What the recording landing answers. */
	readonly landing: ReturnType<LandCreatedAppReceipt>;
}

/** One call of the landing, as the peer records it. */
export interface BringInPeerLanding {
	readonly raw: Record<string, unknown>;
	readonly origin: "blank" | "brought-in";
}

declare global {
	interface Window {
		__bringInPeer?: BringInPeerConfig;
		__bringInLandings?: BringInPeerLanding[];
	}
}

const config = window.__bringInPeer;
if (config === undefined)
	throw new Error(
		"The bring-in peer was opened with no journey's configuration. A journey hands it one through page.addInitScript before the page loads.",
	);
const landings: BringInPeerLanding[] = [];
window.__bringInLandings = landings;

/** `ChatContainer`'s landing, recorded: every call is kept, and the journey's answer returned. */
const landCreatedAppReceipt: LandCreatedAppReceipt = (raw, origin) => {
	landings.push({ raw, origin });
	return config.landing;
};

/**
 * The flow as `/build/new` mounts it: inside the chat card's bounded box, so
 * its middle scrolls and its footer stays, with the page's query read from
 * the address the journey opened.
 */
function Flow(): ReactElement {
	const projectToast = useProjectToast();
	return (
		/* Sized inline: the production stylesheet holds only the classes
		 * production code uses. */
		<div
			className="flex min-h-0 flex-col overflow-hidden rounded-3xl border border-nova-border bg-nova-surface"
			style={{ height: "calc(100dvh - 32px)" }}
		>
			<BringInFlow
				seed={{
					initialSearch: window.location.search,
					projects: config?.projects ?? [],
				}}
				landCreatedAppReceipt={landCreatedAppReceipt}
				projectToast={projectToast}
			/>
		</div>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
	<BuilderSessionProvider
		init={{ projectId: config.tabProjectId, role: "editor", canEdit: true }}
	>
		<CommCareConnectionProvider settings={config.settings}>
			<Flow />
		</CommCareConnectionProvider>
	</BuilderSessionProvider>,
);
