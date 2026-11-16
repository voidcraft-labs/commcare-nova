/**
 * The bring-in flow's one hook: the pure model in a reducer, and one effect
 * that does what `nextAct(model)` says and dispatches what came back.
 *
 * Every request is a plain `fetch` of a route (`bringInClient.ts`): no act of
 * the flow calls the Next router while it is on screen, since a router change
 * would write back the address Next holds and drop the person on the
 * composer.
 *
 * A read belongs to the app it reads. Its request is aborted when the address
 * leaves that app or the flow unmounts, never because the act changed, and an
 * aborted read dispatches nothing. A create is never aborted: it runs to its
 * end on the server, and an answer that arrives once the flow has unmounted is
 * dropped.
 *
 * Two keys live in the tab's session storage, each read once and every access
 * inside `try`/`catch`: `nova:bring-in-create`, the create to send again
 * after a reload, and `nova:brought-in`, which carries the landing's toast
 * across the one landing that loads a page (`BuilderLayout` reads it). A
 * browser that refuses storage costs those two conveniences and nothing else.
 */
"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
	fetchHqApps,
	postCreate,
	postRead,
} from "@/components/bring-in/bringInClient";
import {
	type BringInAct,
	type BringInEvent,
	type BringInModel,
	type BringInScreen,
	initialBringInModel,
	nextAct,
	reduceBringIn,
	resumableCreate,
	screenOf,
} from "@/components/bring-in/bringInModel";
import { useCommCareConnection } from "@/components/builder/CommCareConnectionContext";
import type { useProjectToast } from "@/lib/collab/useProjectToast";
import type {
	AdoptedAppReceipt,
	BringInInput,
	ReadingEvent,
	ReadingKey,
} from "@/lib/deployment";
import {
	BRING_IN_ACTIONS,
	BROUGHT_IN_TOAST_TITLE,
	broughtInToastBody,
} from "@/lib/publish/bringInCopy";
import { bringInLocation } from "@/lib/routing/bringInLocation";
import {
	pushBuilderHistory,
	useBuilderSearchFrom,
} from "@/lib/routing/useClientPath";
import { useProjectId } from "@/lib/session/hooks";

/** What the new-app page hands the flow from the server. */
export interface BringInSeed {
	/** `""`, `?hq=choose` or an app's query, already validated. */
	readonly initialSearch: string;
	/**
	 * Projects where the person holds `edit`: the tab's Project first where it
	 * is one of them, the rest by name. Empty for a person who edits none.
	 */
	readonly projects: readonly {
		readonly id: string;
		readonly name: string;
		/** The person's own Project, which nobody else is in. */
		readonly personal: boolean;
	}[];
}

/** How `ChatContainer` lands a raw creation receipt. */
export type LandCreatedAppReceipt = (
	raw: Record<string, unknown>,
	origin: "blank" | "brought-in",
) => "landed" | "leaving" | "unverified";

/** The create a reload sends again: `{ at, input }`. */
export const BRING_IN_CREATE_KEY = "nova:bring-in-create";

/**
 * The landing that loaded another Project's page: `{ appId, domain, name }`,
 * written before the page is left and read once by the app's own page.
 */
export const BROUGHT_IN_MARKER_KEY = "nova:brought-in";

function readSessionKey(key: string): string | null {
	try {
		return window.sessionStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeSessionKey(key: string, value: string): void {
	try {
		window.sessionStorage.setItem(key, value);
	} catch {
		// A browser that refuses storage costs this convenience alone.
	}
}

function removeSessionKey(key: string): void {
	try {
		window.sessionStorage.removeItem(key);
	} catch {
		// As above.
	}
}

function rememberCreate(input: BringInInput): void {
	writeSessionKey(
		BRING_IN_CREATE_KEY,
		JSON.stringify({ at: Date.now(), input }),
	);
}

/** The Project "Add it to" starts on: the tab's where the person may add to it, else the first. */
function preselectedProject(
	seed: BringInSeed,
	tabProjectId: string | undefined,
): string | null {
	const tabs = seed.projects.find((project) => project.id === tabProjectId);
	return tabs?.id ?? seed.projects[0]?.id ?? null;
}

function sameKey(a: ReadingKey, b: ReadingKey): boolean {
	return (
		a.projectId === b.projectId &&
		a.server === b.server &&
		a.domain === b.domain &&
		a.remoteAppId === b.remoteAppId
	);
}

/** One identity per act: a render that answers the same act starts nothing twice. */
function actKeyOf(act: BringInAct): string {
	return JSON.stringify(act);
}

/** What the landing's marker and toast name, read from the raw receipt before it is parsed. */
function landingNames(receipt: AdoptedAppReceipt): {
	readonly appId: string;
	readonly domain: string;
	readonly name: string;
} | null {
	const appId: unknown = receipt?.appId;
	const domain: unknown = receipt?.adoption?.domain;
	const name: unknown = receipt?.blueprint?.appName;
	return typeof appId === "string" &&
		typeof domain === "string" &&
		typeof name === "string"
		? { appId, domain, name }
		: null;
}

export function useBringIn(input: {
	/** What `freshBuildPage` handed the tree. */
	readonly seed: BringInSeed;
	/** `ChatContainer`'s own landing of a creation receipt. */
	readonly landCreatedAppReceipt: LandCreatedAppReceipt;
	/** `ChatContainer`'s Project-scoped toast, for the landing's toast. */
	readonly projectToast: ReturnType<typeof useProjectToast>;
}): {
	readonly model: BringInModel;
	readonly screen: BringInScreen;
	readonly dispatch: (event: BringInEvent) => void;
} {
	const { seed, landCreatedAppReceipt, projectToast } = input;
	const search = useBuilderSearchFrom(seed.initialSearch);
	const location = useMemo(() => bringInLocation(search), [search]);
	const tabProjectId = useProjectId();
	const [model, dispatchModel] = useReducer(reduceBringIn, location, (first) =>
		initialBringInModel(first, preselectedProject(seed, tabProjectId)),
	);

	/* Refs the requests read when they answer, not when they started. */
	const modelRef = useRef(model);
	modelRef.current = model;
	const tabProjectIdRef = useRef(tabProjectId);
	tabProjectIdRef.current = tabProjectId;
	const landRef = useRef(landCreatedAppReceipt);
	landRef.current = landCreatedAppReceipt;
	const toastRef = useRef(projectToast);
	toastRef.current = projectToast;

	const mountedRef = useRef(true);
	/** The read in flight, with the key it reads. */
	const readRef = useRef<{
		readonly key: ReadingKey;
		readonly controller: AbortController;
	} | null>(null);
	/** The act whose request is in flight, so a second run of the effect for it starts nothing. */
	const startedActRef = useRef<string | null>(null);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			readRef.current?.controller.abort();
			readRef.current = null;
		};
	}, []);

	/* Writes the tab's key wherever the person asks for a create: Bring it in,
	 * and Try again after a create that failed, since the failed line removed
	 * the key and the create is sent again. */
	const dispatch = useCallback((event: BringInEvent) => {
		if (event.type === "create-asked") rememberCreate(event.input);
		if (event.type === "retry") {
			const { failed, pendingCreate } = modelRef.current;
			if (failed === "create" && pendingCreate !== null)
				rememberCreate(pendingCreate);
		}
		dispatchModel(event);
	}, []);

	/* The address. */
	useEffect(() => {
		dispatchModel({ type: "location", location });
		const held = readRef.current;
		if (
			held !== null &&
			(location.kind !== "app" || !sameKey(held.key, location.key))
		) {
			held.controller.abort();
			readRef.current = null;
		}
	}, [location]);

	/* Each time the address becomes an app, before any read: the create the
	 * tab's key holds for it, if one is to be sent again. */
	useEffect(() => {
		if (model.location.kind !== "app" || model.resumeChecked) return;
		const resumed = resumableCreate(
			readSessionKey(BRING_IN_CREATE_KEY),
			model.location.key,
			Date.now(),
		);
		if (resumed === null) removeSessionKey(BRING_IN_CREATE_KEY);
		dispatchModel({ type: "resume", input: resumed });
	}, [model.location, model.resumeChecked]);

	/* The connection as the context holds it now. */
	const connection = useCommCareConnection();
	const domains = useMemo(
		() => connection.availableDomains.map((domain) => domain.name),
		[connection.availableDomains],
	);
	useEffect(() => {
		dispatchModel({ type: "connection", domains });
	}, [domains]);

	const land = useCallback((receipt: AdoptedAppReceipt) => {
		const names = landingNames(receipt);
		/* `landCreatedAppReceipt` assigns the location itself before it answers
		 * `leaving`, so the marker is written first, by the rule it follows: a
		 * receipt for another Project than the tab's loads that app's page. */
		const leavesTab =
			names !== null && receipt.projectId !== tabProjectIdRef.current;
		if (leavesTab)
			writeSessionKey(BROUGHT_IN_MARKER_KEY, JSON.stringify(names));
		const answer = landRef.current(
			receipt as unknown as Record<string, unknown>,
			"brought-in",
		);
		if (answer !== "leaving") removeSessionKey(BROUGHT_IN_MARKER_KEY);
		dispatchModel({
			type: "landed",
			answer,
			appId: names?.appId ?? String(receipt?.appId ?? ""),
		});
		removeSessionKey(BRING_IN_CREATE_KEY);
		if (answer === "landed" && names !== null) {
			toastRef.current(
				"info",
				BROUGHT_IN_TOAST_TITLE,
				broughtInToastBody(names.name, names.domain),
				{
					persistent: true,
					action: {
						label: BRING_IN_ACTIONS.seeWhatCameIn,
						onPress: () =>
							pushBuilderHistory(`/build/${names.appId}/setup/publishing`),
					},
				},
			);
		}
	}, []);

	const startRead = useCallback(async (key: ReadingKey, actKey: string) => {
		const controller = new AbortController();
		readRef.current = { key, controller };
		dispatchModel({ type: "call", call: "read", at: Date.now() });
		const onEvent = (event: ReadingEvent) => {
			if (controller.signal.aborted || !mountedRef.current) return;
			if (event.type === "stage")
				dispatchModel({ type: "stage", stage: event.stage });
			else if (event.type === "files")
				dispatchModel({ type: "files", done: event.done, total: event.total });
		};
		const end = await postRead(key, onEvent, controller.signal);
		if (startedActRef.current === actKey) startedActRef.current = null;
		if (readRef.current?.controller === controller) readRef.current = null;
		if (controller.signal.aborted || !mountedRef.current) return;
		switch (end.kind) {
			case "done":
				dispatchModel({
					type: "read-done",
					answer: end.answer,
					at: Date.now(),
				});
				return;
			case "failed":
				dispatchModel({ type: "failed", call: "read" });
				return;
			case "refused":
				dispatchModel({ type: "refused", call: "read", refusal: end.refusal });
				return;
			case "lost":
				dispatchModel({ type: "lost", call: "read" });
				return;
		}
	}, []);

	const startCreate = useCallback(
		async (createInput: BringInInput, actKey: string) => {
			dispatchModel({ type: "call", call: "create", at: Date.now() });
			const onEvent = (event: ReadingEvent) => {
				if (!mountedRef.current) return;
				if (event.type === "stage")
					dispatchModel({ type: "stage", stage: event.stage });
				else if (event.type === "files")
					dispatchModel({
						type: "files",
						done: event.done,
						total: event.total,
					});
			};
			const end = await postCreate(createInput, onEvent);
			if (startedActRef.current === actKey) startedActRef.current = null;
			if (!mountedRef.current) return;
			switch (end.kind) {
				case "done":
					if (end.answer.kind === "created") {
						land(end.answer.receipt);
						return;
					}
					removeSessionKey(BRING_IN_CREATE_KEY);
					dispatchModel({
						type: "create-done",
						answer: end.answer,
						at: Date.now(),
					});
					return;
				case "failed":
					removeSessionKey(BRING_IN_CREATE_KEY);
					dispatchModel({ type: "failed", call: "create" });
					return;
				case "refused":
					removeSessionKey(BRING_IN_CREATE_KEY);
					dispatchModel({
						type: "refused",
						call: "create",
						refusal: end.refusal,
					});
					return;
				case "lost":
					/* The key stays: the create is still the one on screen. */
					dispatchModel({ type: "lost", call: "create" });
					return;
			}
		},
		[land],
	);

	/* The one effect over the next act. Each act changes the model as its
	 * first step, so the act is another one until its own answer brings it
	 * back; a run of the effect for an act already started starts nothing. The
	 * effect is keyed by the act's identity and reads the act through its ref,
	 * so a render that answers the same act starts nothing twice. */
	const act = nextAct(model);
	const actKey = actKeyOf(act);
	const actRef = useRef(act);
	actRef.current = act;
	useEffect(() => {
		const current = actRef.current;
		switch (current.kind) {
			case "none":
				return;
			case "list-apps": {
				const controller = new AbortController();
				const { domain } = current;
				void fetchHqApps({ domain }, controller.signal).then((answer) => {
					if (controller.signal.aborted || !mountedRef.current) return;
					dispatchModel({
						type: "picker-apps",
						domain,
						picker: answer.ok ? answer.value : null,
					});
				});
				/* The list belongs to its project space: choosing another, or
				 * leaving the picker, stops it. */
				return () => controller.abort();
			}
			case "read":
			case "create": {
				const start = () => {
					if (startedActRef.current === actKey) return;
					startedActRef.current = actKey;
					if (current.kind === "read") void startRead(current.key, actKey);
					else void startCreate(current.input, actKey);
				};
				if (current.afterMs <= 0) {
					start();
					return;
				}
				const timer = setTimeout(start, current.afterMs);
				return () => clearTimeout(timer);
			}
		}
	}, [actKey, startCreate, startRead]);

	return { model, screen: screenOf(model), dispatch };
}
