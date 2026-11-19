import { type ReactNode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { BuilderAccessGate } from "@/components/builder/AccessStatus";
import { BuilderHeader } from "@/components/builder/BuilderHeader";
import { CommCareConnectionProvider } from "@/components/builder/CommCareConnectionContext";
import { ScrollRegistryProvider } from "@/components/builder/contexts/ScrollRegistryContext";
import { DeploymentTargetProvider } from "@/components/builder/DeploymentTargetProvider";
import { HqChangesDialog } from "@/components/builder/HqChangesDialog";
import { Button } from "@/components/shadcn/button";
import {
	type HeaderSlots,
	HeaderSlotsProvider,
} from "@/components/ui/headerSlots";
import { ToastContainer } from "@/components/ui/ToastContainer";
import { ReconcilerProvider } from "@/lib/collab/ReconcilerProvider";
import { endpointWireFixture } from "@/lib/commcare/__tests__/endpointWireFixture";
import { isDeploymentServer } from "@/lib/deployment";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import {
	BuilderSessionProvider,
	useBuilderSessionApi,
} from "@/lib/session/provider";

/**
 * The changes made in CommCare HQ panel's two homes as the builder mounts
 * them, in the production providers they read: the doc and session stores,
 * the reconciler (whose app stream says a bring-in of changes forced a
 * reload, and whose reload says so in a toast), the deployment target and
 * the CommCare HQ connection.
 *
 * The header is the production `BuilderHeader`, portaling its document
 * controls into a band's actions cell as the app shell's band gives it one:
 * the Publish button and its dialog, See what changed in CommCare HQ, and
 * the host that opens the card's dialog on a bring-in this tab sent once the
 * reload its commit forced has landed, each gated as the header gates them.
 * The page itself is under the production access gate, which masks it and
 * closes every floating layer while the app reloads; on it stands the
 * Publishing card's See what changed, which opens the card's dialog on
 * `alpha`. Nova's own routes are answered by the journey; the Server Actions
 * go through `publishing-boundary.ts` as plain requests.
 *
 * `?changed=production:alpha` stands for the check when the builder opens
 * having found the app changed on that project space.
 */

/* The app, its Project and the member, as the journeys' routes name them. */
const appId = "native-hq-changes";
const projectId = "native-project";
const userId = "native-user";
/* The doc's app is the one the routes name, as the builder's doc is. */
const doc = { ...endpointWireFixture("multiple"), appId };
const params = new URLSearchParams(location.search);
/* The member's Project role: `admin` may stop publishing, `editor` may not. */
const role = params.get("role") ?? "admin";
const changed = params.get("changed");

/** The band the app shell mounts: the cell the builder's controls portal into. */
function Band({ children }: { readonly children: ReactNode }) {
	const [actions, setActions] = useState<HTMLElement | null>(null);
	const slots = useMemo<HeaderSlots>(
		() => ({ center: null, actions, account: null, claim: () => undefined }),
		[actions],
	);
	return (
		<HeaderSlotsProvider value={slots}>
			<header ref={setActions} />
			{children}
		</HeaderSlotsProvider>
	);
}

/** What the check when the builder opens found, where the journey names it. */
function CheckFound() {
	const session = useBuilderSessionApi();
	useEffect(() => {
		if (changed === null) return;
		const [server, domain] = changed.split(":");
		if (!isDeploymentServer(server) || domain === undefined) return;
		session.getState().setHqChangedTargets([{ server, domain }]);
	}, [session]);
	return null;
}

/** The Publishing card's See what changed, and the dialog it opens. */
function PublishingCard() {
	const [open, setOpen] = useState(false);
	return (
		<main>
			<Button onClick={() => setOpen(true)}>See what changed</Button>
			{open ? (
				<HqChangesDialog
					open
					onOpenChange={setOpen}
					target={{ server: "production", domain: "alpha" }}
				/>
			) : null}
		</main>
	);
}

function Content() {
	return (
		/* The app shell, as `(app)/layout.tsx` marks it: the one body child
		 * the access gate never quarantines. */
		<div data-nova-app-shell>
			<Band>
				<CheckFound />
				<BuilderHeader onSetPreviewing={() => undefined} />
				<BuilderAccessGate>
					<PublishingCard />
				</BuilderAccessGate>
			</Band>
			<ToastContainer />
		</div>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
	<BlueprintDocProvider
		initialDoc={toPersistableDoc(doc)}
		appId={appId}
		canEdit
	>
		<BuilderSessionProvider
			init={{
				appId,
				projectId,
				role,
				canEdit: true,
			}}
		>
			<ScrollRegistryProvider>
				<ReconcilerProvider appId={appId} baseSeq={0} userId={userId}>
					<DeploymentTargetProvider
						initialProjectSpace={null}
						initialTargetFacts={null}
					>
						<CommCareConnectionProvider
							settings={{
								configured: true,
								username: "native-user@dimagi.com",
								server: "production",
								availableDomains: [{ name: "alpha", displayName: "Alpha" }],
							}}
						>
							<Content />
						</CommCareConnectionProvider>
					</DeploymentTargetProvider>
				</ReconcilerProvider>
			</ScrollRegistryProvider>
		</BuilderSessionProvider>
	</BlueprintDocProvider>,
);
