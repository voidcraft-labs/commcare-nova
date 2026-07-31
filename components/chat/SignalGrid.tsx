"use client";
import type { UIMessage } from "ai";
import { useCallback, useContext, useEffect, useRef } from "react";
import { orderedFormUuids, orderedModuleUuids } from "@/lib/doc/fieldWalk";
import {
	BlueprintDocContext,
	type BlueprintDocStore,
} from "@/lib/doc/provider";
import type { EditScope } from "@/lib/session/builderTypes";
import { derivePostBuildEdit } from "@/lib/session/lifecycle";
import type { BuilderSessionStoreApi } from "@/lib/session/provider";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { computeEditFocus } from "@/lib/signalGrid/editFocus";
import { signalGrid } from "@/lib/signalGrid/store";
import type { SignalGridController } from "@/lib/signalGridController";

interface SignalGridProps {
	/** Controller instance — created and owned by the parent (ChatSidebar). */
	controller: SignalGridController;
	messages: UIMessage[];
}

export function SignalGrid({ controller, messages }: SignalGridProps) {
	const sessionApi = useBuilderSessionApi();
	const docStore = useContext(BlueprintDocContext);
	/* Keep refs to both stores so the effect's closure always reads the
	 * latest identity. `sessionApi` is stable per BuilderProvider mount;
	 * `docStore` is stable per BlueprintDocProvider mount. */
	const sessionApiRef = useRef<BuilderSessionStoreApi>(sessionApi);
	sessionApiRef.current = sessionApi;
	const docStoreRef = useRef<BlueprintDocStore | null>(docStore);
	docStoreRef.current = docStore;
	/** Null on mount — the first effect records the baseline content length
	 *  without injecting energy, preventing a massive brightness spike from
	 *  all existing message content being treated as a delta on remount. */
	const prevContentLenRef = useRef<number | null>(null);

	const gridCallbackRef = useCallback(
		(el: HTMLDivElement | null) => {
			if (!el) return;
			controller.attach(el);
			controller.powerOn();

			const ro = new ResizeObserver(() => controller.resize());
			ro.observe(el);

			return () => {
				ro.disconnect();
				controller.detach();
			};
		},
		[controller],
	);

	useEffect(() => {
		const lastAssistant = findLastAssistant(messages);
		if (!lastAssistant) {
			prevContentLenRef.current = 0;
			return;
		}

		let contentLen = 0;
		let latestToolScope: EditScope | null = null;

		for (const part of lastAssistant.parts) {
			if ((part.type === "text" || part.type === "reasoning") && part.text) {
				contentLen += part.text.length;
			}
			if (
				part.type?.startsWith("tool-") &&
				"input" in part &&
				part.input != null
			) {
				contentLen += JSON.stringify(part.input).length;

				const input = part.input as Record<string, unknown>;
				if (typeof input.moduleUuid === "string") {
					latestToolScope = { moduleUuid: input.moduleUuid };
					if (typeof input.formUuid === "string") {
						latestToolScope.formUuid = input.formUuid;
						if (typeof input.fieldUuid === "string") {
							latestToolScope.fieldUuid = input.fieldUuid;
						}
					}
				}
			}
		}

		// On first run (mount/remount), record baseline without injecting energy.
		// Content generated while unmounted doesn't need a brightness burst -- the
		// headless tick was already advancing state from burst energy data parts.
		if (prevContentLenRef.current !== null) {
			const delta = contentLen - prevContentLenRef.current;
			if (delta > 0) {
				signalGrid.injectThinkEnergy(delta * 2);
			}
		}
		prevContentLenRef.current = contentLen;

		const s = sessionApiRef.current.getState();
		const doc = docStoreRef.current?.getState();
		/* `derivePostBuildEdit` returns true only while a run is in
		 * progress (events buffer non-empty), so a separate "agent
		 * active" check would be redundant. */
		if (doc && derivePostBuildEdit(s.events, s.runStartedWithData)) {
			/* Hand the UUID-backed scope the current display sequences. Reorders
			 * change only where the focus renders, never which entity it follows. */
			const orderedModules = orderedModuleUuids(doc);
			const orderedForms: Record<string, readonly string[]> = {};
			for (const moduleId of orderedModules) {
				orderedForms[moduleId] = orderedFormUuids(doc, moduleId);
			}
			controller.setEditFocus(
				computeEditFocus(
					{
						moduleOrder: orderedModules,
						formOrder: orderedForms,
						fieldOrder: doc.fieldOrder,
					},
					latestToolScope,
				),
			);
		}
	}, [messages, controller]);

	return <div ref={gridCallbackRef} className="signal-grid" />;
}

function findLastAssistant(messages: UIMessage[]): UIMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") return messages[i];
	}
}
