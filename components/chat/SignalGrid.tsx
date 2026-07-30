"use client";
import type { UIMessage } from "ai";
import { useCallback, useContext, useEffect, useRef } from "react";
import {
	orderedFieldUuids,
	orderedFormUuids,
	orderedModuleUuids,
} from "@/lib/doc/fieldWalk";
import {
	BlueprintDocContext,
	type BlueprintDocStore,
} from "@/lib/doc/provider";
import { type BlueprintDoc, type Uuid, uuidSchema } from "@/lib/domain";
import type { EditScope } from "@/lib/session/builderTypes";
import { derivePostBuildEdit } from "@/lib/session/lifecycle";
import type { BuilderSessionStoreApi } from "@/lib/session/provider";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { computeEditFocus } from "@/lib/signalGrid/editFocus";
import { signalGrid } from "@/lib/signalGrid/store";
import type { SignalGridController } from "@/lib/signalGridController";

/**
 * Walk the form's normalized subtree depth-first and return the flat
 * 0-based index of the field with the requested stable UUID. Returns -1 when
 * the form is empty or that field is not part of the form.
 *
 * SA tool events carry UUID identity; the signal grid locally projects it to
 * the flat rendered index its activity gauge consumes.
 */
function flatIndexInForm(
	doc: BlueprintDoc,
	formUuid: Uuid,
	targetUuid: Uuid,
): number {
	let index = 0;
	let found = -1;
	const walk = (parent: Uuid): boolean => {
		// The flat index feeds the activity gauge's focus range over the form's
		// rendered field layout, so it counts in `fieldOrder` sequence.
		const children = orderedFieldUuids(doc, parent);
		for (const childUuid of children) {
			if (childUuid === targetUuid) {
				found = index;
				return true;
			}
			const field = doc.fields[childUuid];
			if (!field) continue;
			index++;
			if (walk(childUuid)) return true;
		}
		return false;
	};
	walk(formUuid);
	return found;
}

/** Tool events are historical display input. Ignore stale/non-canonical
 * identities instead of throwing from the chat renderer. */
function canonicalToolUuid(value: unknown): Uuid | undefined {
	const parsed = uuidSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

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
				const doc = docStoreRef.current?.getState();
				const moduleUuid = canonicalToolUuid(input.moduleUuid);
				const moduleIndex =
					doc && moduleUuid ? orderedModuleUuids(doc).indexOf(moduleUuid) : -1;
				if (doc && moduleUuid && moduleIndex >= 0) {
					latestToolScope = { moduleIndex };
					const formUuid = canonicalToolUuid(input.formUuid);
					const formIndex = formUuid
						? orderedFormUuids(doc, moduleUuid).indexOf(formUuid)
						: -1;
					if (formUuid && formIndex >= 0) {
						latestToolScope.formIndex = formIndex;
						const fieldUuid = canonicalToolUuid(input.fieldUuid);
						if (fieldUuid) {
							const flatIdx = flatIndexInForm(doc, formUuid, fieldUuid);
							if (flatIdx >= 0) latestToolScope.fieldIndex = flatIdx;
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
			/* computeEditFocus converts scope indices into a 0–1 focus range.
			 * It's order-agnostic (it lays fields out in the sequence it's
			 * given), so hand it the same membership-array sequence the scope
			 * indices address and the canvas renders. */
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
