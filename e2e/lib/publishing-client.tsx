import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DeploymentEntryPointLinks } from "@/components/builder/app-setup/DeploymentEntryPointLinks";
import { PublishingSection } from "@/components/builder/app-setup/PublishingSection";
import {
	CommCareConnectionProvider,
	useCommCareConnection,
} from "@/components/builder/CommCareConnectionContext";
import { DeploymentTargetProvider } from "@/components/builder/DeploymentTargetProvider";
import {
	PublishDialog,
	type PublishDownloadOutcome,
	type PublishProjectSpaceCompatibilityOutcome,
} from "@/components/builder/PublishDialog";
import { Button } from "@/components/shadcn/button";
import { ReconcilerProvider } from "@/lib/collab/ReconcilerProvider";
import { endpointWireFixture } from "@/lib/commcare/__tests__/endpointWireFixture";
import { type CommCareServer, isDeploymentServer } from "@/lib/deployment";
import type { DeploymentView } from "@/lib/deployment/actions";
import { buildSetupArtifact } from "@/lib/deployment/setupArtifact";
import { NO_DEPLOYMENT_PHASE_OUTCOMES } from "@/lib/deployment/types";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { OrganizationLevel } from "@/lib/domain";
import { asUuid } from "@/lib/domain/uuid";
import {
	decodeManualImportGuide,
	MANUAL_IMPORT_GUIDE_HEADER,
} from "@/lib/publish/manualImportGuide";
import {
	BuilderSessionProvider,
	useBuilderSessionApi,
} from "@/lib/session/provider";

const appId = "native-publishing";
const params = new URLSearchParams(location.search);
/* One persona, so the Publishing section's Workers panel has someone to make
 * an account for, and one organization level whose CommCare HQ code differs
 * from its name, which a worker-level confirmation on the card is named by. */
const PERSONA_UUID = asUuid("0199a000-0000-7000-8000-00000000a001");
const LEVEL_UUID = asUuid("0199a000-0000-7000-8000-00000000b001");
const LEVEL: OrganizationLevel = {
	uuid: LEVEL_UUID,
	code: "District_Level",
	name: "District",
	caseFlow: {
		workers: "assigned",
		ownsCases: true,
		descendantCases: { kind: "none" },
	},
	addressBook: { reach: "own-branch" },
};
const fixture = endpointWireFixture("multiple");
const baseDoc =
	params.get("persona") === "true"
		? {
				...fixture,
				personas: {
					[PERSONA_UUID]: { uuid: PERSONA_UUID, name: "Nurse" },
				},
				personaOrder: [PERSONA_UUID],
				organizationLevels: { [LEVEL_UUID]: LEVEL },
				organizationLevelOrder: [LEVEL_UUID],
			}
		: fixture;
const doc={...baseDoc,appSettings:{...baseDoc.appSettings,...(params.has("webOnly") && {runsOnlyOn:"web-apps" as const}),...(params.has("installations") && {installationProfiles:Object.fromEntries(["","Team","Team"].map((name,i)=>{
	const uuid=asUuid("0199a000-0000-7000-8000-00000000a00"+i);
	return [uuid,{uuid,name,languages:["eng"],requiresPracticeWorker:i===2}];
}))})}};
const viewer = params.get("viewer") === "true";
/* The member's Project role: `admin` may stop publishing, `editor` may not. */
const role = params.get("role") ?? undefined;
/* The App setup Publishing section in place of the dialog. */
const section = params.get("section") === "true";
/* `server:domain` of a project space the check when the builder opens found
 * changed in CommCare HQ, as `HqChangesCheck` writes it to the session. */
const changed = params.get("changed");
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
			offeredLogoContentHash: null,
			targetEmptyCaseListText: null,
			endings: 0,
		},
		active: [],
		superseded: [],
		confirmations: [],
	},
	artifact: buildSetupArtifact({
		doc,
		server: "india",
		domain: "alpha",
		hqAppId: null,
		organization: { locations: [] },
	}),
	leftBehind: [],
	kept: null,
	firstPublish: null,
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
async function downloadCcz(target: {
	readonly server: string;
	readonly domain: string;
 readonly installationProfileUuid?: string;
}): Promise<PublishDownloadOutcome> {
	const response = await fetch(
		`/publishing/download/ccz?server=${target.server}&domain=${target.domain}${target.installationProfileUuid?"&profile="+target.installationProfileUuid:""}`,
	);
	return response.json();
}
/* The import file's answer as PublishPanel reads it: the bytes, and the
 * guide's steps from the header beside them. */
async function downloadImportFile(
	server?: string,
): Promise<PublishDownloadOutcome> {
	const response = await fetch("/api/compile/json", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ appId, ...(server ? { server } : {}) }),
	});
	if (!response.ok) return { ok: false };
	await response.blob();
	return {
		ok: true,
		manualImportGuide: decodeManualImportGuide(
			response.headers.get(MANUAL_IMPORT_GUIDE_HEADER),
		),
	};
}
function Content() {
	const [open, setOpen] = useState(false);
	const [mounted, setMounted] = useState(true);
	const [destination, setDestination] = useState("alpha");
	/* The production context, as PublishPanel reads it, with a test's own
	 * connection taking its place once one is sent. */
	const context = useCommCareConnection();
	const [sent, setSent] = useState<{
		server: CommCareServer;
		domains: typeof domains;
	} | null>(null);
	useEffect(() => {
		const receive = (event: Event) =>
			setSent((event as CustomEvent<NonNullable<typeof sent>>).detail);
		window.addEventListener("publishing-connection", receive);
		return () => window.removeEventListener("publishing-connection", receive);
	}, []);
	const connection = sent ?? {
		server: context.server,
		domains: context.availableDomains,
	};
	const session = useBuilderSessionApi();
	useEffect(() => {
		if (changed === null) return;
		const [server, domain] = changed.split(":");
		if (!isDeploymentServer(server) || domain === undefined) return;
		session.getState().setHqChangedTargets([{ server, domain }]);
	}, [session]);
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
				(section ? (
					<PublishingSection />
				) : params.get("links") === "true" ? (
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
						availableDomains={connection.domains}
						connectionServer={
							connection.domains.length ? connection.server : null
						}
						canUploadToHq={!viewer}
						onOpenPublishing={() => setOpen(false)}
						isRefreshingHqConnection={context.isRefreshing}
						hqConnectionRefreshFailed={context.refreshFailed}
						onRefreshHqConnection={() => void context.refresh()}
						onLoadProjectSpaceCompatibility={loadCompatibility}
						onDownloadJson={downloadImportFile}
						onDownloadCcz={downloadCcz}
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
			init={{ appId, projectId: "native-project", role, canEdit: !viewer }}
		>
			<ReconcilerProvider appId={appId} baseSeq={0} userId="native-user">
				<DeploymentTargetProvider
					initialProjectSpace={null}
					initialTargetFacts={null}
				>
					<CommCareConnectionProvider
						settings={
							domains.length > 0
								? {
										configured: true,
										username: "native-user@dimagi.com",
										server: "production",
										availableDomains: domains,
									}
								: { configured: false }
						}
					>
						<Content />
					</CommCareConnectionProvider>
				</DeploymentTargetProvider>
			</ReconcilerProvider>
		</BuilderSessionProvider>
	</BlueprintDocProvider>,
);
