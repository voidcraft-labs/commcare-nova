import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { DeploymentEntryPointLinks } from "@/components/builder/app-setup/DeploymentEntryPointLinks";
import { DeploymentTargetProvider } from "@/components/builder/DeploymentTargetProvider";
import {
	PublishDialog,
	type PublishDownloadOutcome,
	type PublishProjectSpaceCompatibilityOutcome,
} from "@/components/builder/PublishDialog";
import { Button } from "@/components/shadcn/button";
import { ReconcilerProvider } from "@/lib/collab/ReconcilerProvider";
import { endpointWireFixture } from "@/lib/commcare/__tests__/endpointWireFixture";
import type { DeploymentView } from "@/lib/deployment/actions";
import { buildSetupArtifact } from "@/lib/deployment/setupArtifact";
import { NO_DEPLOYMENT_PHASE_OUTCOMES } from "@/lib/deployment/types";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import {
	BuilderSessionProvider,
	useBuilderSessionApi,
} from "@/lib/session/provider";

const appId = "native-publishing";
const doc = endpointWireFixture("multiple");
const params = new URLSearchParams(location.search);
const viewer = params.get("viewer") === "true";
const domains =
	params.get("disconnected") === "true"
		? []
		: params.get("multi") === "true"
			? [
					{ name: "alpha", displayName: "Alpha" },
					{ name: "beta", displayName: "Beta" },
				]
			: [{ name: "alpha", displayName: "Alpha" }];
const view: DeploymentView = {
	deployment: {
		deployment: {
			id: "deployment",
			appId,
			projectId: "native-project",
			server: "india",
			domain: "alpha",
			state: "preflight",
			resumePhase: null,
			phases: NO_DEPLOYMENT_PHASE_OUTCOMES,
			createdBy: "native-user",
			createdAt: "2026-09-06T00:00:00Z",
			updatedAt: "2026-09-06T00:00:00Z",
			lastObservedAt: null,
		},
		active: [],
		superseded: [],
	},
	artifact: buildSetupArtifact({
		doc,
		server: "india",
		domain: "alpha",
		hqAppId: null,
		locations: [],
	}),
	leftBehind: [],
};
const getAppId = () => appId;
async function loadCompatibility(
	domain: string | undefined,
	signal: AbortSignal,
): Promise<PublishProjectSpaceCompatibilityOutcome> {
	// PublishPanel's real callback resolves transport cancellations to the
	// public outcome union. This peer supplies that same callback contract.
	try {
		const response = await fetch(
			`/publishing/compatibility?domain=${domain ?? ""}`,
			{ signal },
		);
		return await response.json();
	} catch (error) {
		if (!signal.aborted) throw error;
		return { ok: false, message: "The compatibility check was canceled" };
	}
}
async function download(
	kind: string,
	server?: string,
): Promise<PublishDownloadOutcome> {
	const response = await fetch(
		`/publishing/download/${kind}?server=${server ?? ""}`,
	);
	return response.json();
}
function Content() {
	const [open, setOpen] = useState(false);
	const [mounted, setMounted] = useState(true);
	const [destination, setDestination] = useState("alpha");
	const session = useBuilderSessionApi();
	const mutations = useBlueprintMutations();
	const close = useCallback(() => setOpen(false), []);
	return (
		<>
			<Button onClick={() => setOpen(true)}>Open publish</Button>
			<Button onClick={() => setMounted(false)}>Unmount publishing</Button>
			<Button
				onClick={() =>
					session.getState().applyAccessSnapshot({
						projectId: "native-project",
						role: "viewer",
						canEdit: false,
					})
				}
			>
				Lose edit access
			</Button>
			<Button
				onClick={() => {
					const result = mutations.inline.commitMany([
						{ kind: "setAppName", name: "Peer changed title" },
					]);
					if (!result.ok) throw new Error(JSON.stringify(result));
				}}
			>
				Edit document
			</Button>
			<Button onClick={() => setDestination("beta")}>
				Change deployment target
			</Button>
			{mounted &&
				(params.get("links") === "true" ? (
					<DeploymentEntryPointLinks
						appId={appId}
						view={{
							...view,
							deployment: {
								...view.deployment,
								deployment: {
									...view.deployment.deployment,
									domain: destination,
								},
							},
						}}
					/>
				) : (
					<PublishDialog
						open={open}
						onClose={close}
						getAppId={getAppId}
						availableDomains={domains}
						connectionServer={domains.length ? "production" : null}
						canUploadToHq={!viewer && domains.length > 0}
						onOpenPublishing={() => setOpen(false)}
						isRefreshingHqConnection={false}
						onRefreshHqConnection={() => {}}
						onLoadProjectSpaceCompatibility={loadCompatibility}
						onDownloadJson={(server) => download("json", server)}
						onDownloadCcz={(server) => download("ccz", server)}
					/>
				))}
		</>
	);
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
	<BlueprintDocProvider
		initialDoc={toPersistableDoc(doc)}
		appId={appId}
		canEdit={!viewer}
	>
		<BuilderSessionProvider
			init={{ appId, projectId: "native-project", canEdit: !viewer }}
		>
			<ReconcilerProvider appId={appId} baseSeq={0} userId="native-user">
				<DeploymentTargetProvider initialProjectSpace={null}>
					<Content />
				</DeploymentTargetProvider>
			</ReconcilerProvider>
		</BuilderSessionProvider>
	</BlueprintDocProvider>,
);
