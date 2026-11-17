/**
 * Bringing an app in from CommCare HQ, as one surface of `/build/new`: it
 * takes the chat card's place in the centred column, inside `ChatContainer`'s
 * tree, so an app it creates lands through the same installer as every other
 * birth and creation never navigates.
 *
 * It calls `useBringIn` itself, so the flow's state lives exactly as long as
 * it is mounted, and it draws the screen `screenOf(model)` names. The four
 * short screens are its own: Nova's own failure, a refusal that leaves
 * nothing else to show, an app that exists and this tab could not open, and a
 * session that ended. Every other screen is a component of its own, handed
 * what the model gives. Above them all stands the flow's one status region,
 * which outlives a change of screen so a new screen's lead is announced.
 */
"use client";

import Link from "next/link";
import { useMemo } from "react";
import { BringInAccount } from "@/components/bring-in/BringInAccount";
import { BringInPicker } from "@/components/bring-in/BringInPicker";
import { BringInReading } from "@/components/bring-in/BringInReading";
import { BringInReview } from "@/components/bring-in/BringInReview";
import {
	type BringInLead,
	BringInScreenLayout,
	BringInStatusRegion,
} from "@/components/bring-in/BringInScreenLayout";
import { BringInStop } from "@/components/bring-in/BringInStop";
import {
	type BringInModel,
	circumstanceContextOf,
	knownAppName,
	reviewProjectOf,
	type StopAction,
	stopActions,
} from "@/components/bring-in/bringInModel";
import {
	type BringInSeed,
	type LandCreatedAppReceipt,
	useBringIn,
} from "@/components/bring-in/useBringIn";
import { useCommCareConnection } from "@/components/builder/CommCareConnectionContext";
import { keptDateText } from "@/components/builder/keptListModel";
import { Button } from "@/components/shadcn/button";
import type { useProjectToast } from "@/lib/collab/useProjectToast";
import {
	type CommCareServer,
	deploymentServerLabel,
	type ReadingRefusal,
} from "@/lib/deployment";
import {
	BRING_IN_ACTIONS,
	PICKER_HEADING,
	readFailedAfterCreateBody,
	SIGNED_OUT_LINE,
	SIGNED_OUT_TITLE,
} from "@/lib/publish/bringInCopy";
import {
	READING_FAILED_COPY,
	READING_REFUSAL_COPY,
	UNVERIFIED_LANDING_BODY,
	UNVERIFIED_LANDING_TITLE,
} from "@/lib/publish/hqReadingCopy";
import { bringInHref } from "@/lib/routing/bringInLocation";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";

/** The picker, where Choose another app, Choose an app and Choose another Project all lead. */
function toPicker(): void {
	pushBuilderHistory(bringInHref({ kind: "choose" }));
}

/** A date in the reader's locale, as the kept list writes one. */
function formatDate(iso: string): string {
	return keptDateText(iso, new Date());
}

/** The server the screen is about: the app's address, else the loaded list's, else the connection's. */
function serverOf(
	model: BringInModel,
	connected: CommCareServer | null,
): CommCareServer | null {
	if (model.location.kind === "app") return model.location.key.server;
	const { apps } = model.picker;
	if (apps.kind === "loaded" && apps.picker.kind === "apps")
		return apps.picker.server;
	return connected;
}

function GoToYourApps({ primary = false }: { readonly primary?: boolean }) {
	return (
		<Button
			variant={primary ? "default" : "outline"}
			nativeButton={false}
			render={<Link href="/" />}
		>
			{BRING_IN_ACTIONS.goToYourApps}
		</Button>
	);
}

/**
 * Nova's own failure, in a read or a create: Try again sends the same request.
 * A read that follows a create's `read-again` keeps that create's lead above
 * it, and says "No app was created": the create may have added the app's
 * files to the Project before it answered.
 */
function FailedScreen({
	operation,
	appName,
	lead,
	onRetry,
}: {
	readonly operation: "read" | "create";
	readonly appName: string | null;
	readonly lead: BringInLead;
	readonly onRetry: () => void;
}) {
	const copy = READING_FAILED_COPY[operation];
	return (
		<BringInScreenLayout
			title={copy.title}
			icon="info"
			lead={lead}
			description={
				operation === "read" && lead !== null
					? readFailedAfterCreateBody(appName)
					: copy.body(appName)
			}
			footer={
				<>
					<Button type="button" onClick={onRetry}>
						{BRING_IN_ACTIONS.tryAgain}
					</Button>
					<GoToYourApps />
				</>
			}
		/>
	);
}

/** A refusal that leaves nothing else to show: its sentence, and the way on it allows. */
function RefusedScreen({ refusal }: { readonly refusal: ReadingRefusal }) {
	const choose =
		refusal === "no_project_access"
			? BRING_IN_ACTIONS.chooseAnotherProject
			: refusal === "app_unavailable"
				? null
				: BRING_IN_ACTIONS.chooseAnApp;
	return (
		<BringInScreenLayout
			title={PICKER_HEADING}
			footer={
				<>
					{choose !== null ? (
						<Button type="button" onClick={toPicker}>
							{choose}
						</Button>
					) : null}
					<GoToYourApps primary={choose === null} />
				</>
			}
		>
			<p role="alert" className="text-sm leading-relaxed text-nova-text">
				{READING_REFUSAL_COPY[refusal]}
			</p>
		</BringInScreenLayout>
	);
}

/** The app exists, and this tab could not open it: a plain link loads its own page. */
function UnopenedScreen({ appId }: { readonly appId: string }) {
	return (
		<BringInScreenLayout
			title={UNVERIFIED_LANDING_TITLE}
			icon="info"
			description={UNVERIFIED_LANDING_BODY}
			footer={
				<>
					<Button nativeButton={false} render={<a href={`/build/${appId}`} />}>
						{BRING_IN_ACTIONS.openYourApp}
					</Button>
					<GoToYourApps />
				</>
			}
		/>
	);
}

/** A request answered that the session ended: only a reload, which signs the person in again, goes on. */
function SignedOutScreen() {
	return (
		<BringInScreenLayout
			title={SIGNED_OUT_TITLE}
			icon="info"
			description={SIGNED_OUT_LINE}
			footer={
				<>
					<Button type="button" onClick={() => window.location.reload()}>
						{BRING_IN_ACTIONS.reload}
					</Button>
					<GoToYourApps />
				</>
			}
		/>
	);
}

export function BringInFlow({
	seed,
	landCreatedAppReceipt,
	projectToast,
}: {
	/** What `freshBuildPage` handed the tree. */
	readonly seed: BringInSeed;
	/** `ChatContainer`'s landing of a creation receipt. */
	readonly landCreatedAppReceipt: LandCreatedAppReceipt;
	/** `ChatContainer`'s Project-scoped toast. */
	readonly projectToast: ReturnType<typeof useProjectToast>;
}) {
	const { model, screen, dispatch } = useBringIn({
		seed,
		landCreatedAppReceipt,
		projectToast,
	});
	const connection = useCommCareConnection();
	const server = serverOf(model, connection.server);
	const serverLabel = server === null ? "" : deploymentServerLabel(server);
	const context = useMemo(
		() => circumstanceContextOf(model, serverLabel, formatDate),
		[model, serverLabel],
	);
	const retry = () => dispatch({ type: "retry" });
	const onStopAction = (action: StopAction) => {
		if (action.kind === "check-again") dispatch({ type: "read-asked" });
		else if (action.kind === "choose-another-app") toPicker();
	};

	const body = (() => {
		switch (screen.kind) {
			case "none":
				return null;
			case "signed-out":
				return <SignedOutScreen />;
			case "choose":
				return (
					<BringInPicker
						model={model}
						dispatch={dispatch}
						seed={seed}
						serverLabel={serverLabel}
						context={context}
						onReadApp={(remoteAppId) => {
							const { apps, projectId, domain } = model.picker;
							if (
								apps.kind !== "loaded" ||
								apps.picker.kind !== "apps" ||
								projectId === null ||
								domain === null
							)
								return;
							pushBuilderHistory(
								bringInHref({
									kind: "app",
									key: {
										projectId,
										server: apps.picker.server,
										domain,
										remoteAppId,
									},
								}),
							);
						}}
					/>
				);
			case "reading":
			case "creating":
				return (
					<BringInReading
						mode={screen.kind}
						model={model}
						appName={knownAppName(model)}
						lost={screen.lost}
						onRetry={retry}
					/>
				);
			case "failed":
				return (
					<FailedScreen
						operation={screen.operation}
						appName={
							screen.operation === "create"
								? (model.pendingCreate?.appName ?? knownAppName(model))
								: knownAppName(model)
						}
						lead={screen.operation === "read" ? model.lead : null}
						onRetry={retry}
					/>
				);
			case "refused":
				return <RefusedScreen refusal={screen.refusal} />;
			case "unopened":
				return <UnopenedScreen appId={screen.appId} />;
			case "stopped":
				return (
					<BringInStop
						finding={screen.finding}
						context={context}
						lead={model.lead}
						actions={stopActions(screen.finding)}
						onAction={onStopAction}
					/>
				);
			case "account":
				if (model.location.kind !== "app") return null;
				return (
					<BringInAccount
						model={model}
						readingKey={model.location.key}
						answer={screen.answer}
						context={context}
						dispatch={dispatch}
					/>
				);
			case "review": {
				if (model.location.kind !== "app") return null;
				const project = reviewProjectOf(seed.projects, model.location.key);
				/* The address names a Project this page was not handed: a role
				 * granted after it loaded. A reload hands it down. */
				if (project === null) return <RefusedScreen refusal="invalid_input" />;
				return (
					<BringInReview
						model={model}
						readingKey={model.location.key}
						answer={screen.answer}
						answers={screen.answers}
						project={project}
						context={context}
						dispatch={dispatch}
					/>
				);
			}
		}
	})();

	return (
		<div className="flex min-h-0 flex-auto flex-col">
			<BringInStatusRegion>
				<div
					className="flex min-h-0 flex-auto flex-col"
					data-bring-in-flow={screen.kind}
					key={screen.kind}
				>
					{body}
				</div>
			</BringInStatusRegion>
		</div>
	);
}
