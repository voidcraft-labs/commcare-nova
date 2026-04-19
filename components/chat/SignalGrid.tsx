"use client";
import type { UIMessage } from "ai";
import { useCallback, useContext, useEffect, useRef } from "react";
import { docHasData } from "@/lib/doc/predicates";
import {
	BlueprintDocContext,
	type BlueprintDocStore,
} from "@/lib/doc/provider";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import type { EditScope } from "@/lib/services/builder";
import { type QuestionPath, qpathId } from "@/lib/services/questionPath";
import { derivePostBuildEdit } from "@/lib/session/lifecycle";
import type { BuilderSessionStoreApi } from "@/lib/session/provider";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { computeEditFocus } from "@/lib/signalGrid/editFocus";
import { signalGrid } from "@/lib/signalGrid/store";
import type { SignalGridController } from "@/lib/signalGridController";

/**
 * Walk the form's normalized subtree depth-first and return the flat
 * 0-based index of the first field whose bare `id` matches. Returns -1
 * when the form is empty or the id is not present.
 *
 * The SA's tool events reference fields by their semantic id; the signal
 * grid consumes flat indices so its activity gauge can compute a focus
 * range over the form's linear field sequence. This helper replaces the
 * old wire-format `flatIndexById` walk — the normalized doc's
 * `fieldOrder` is the single source of ordering truth.
 */
function flatIndexInForm(
	doc: BlueprintDoc,
	formUuid: Uuid,
	bareId: string,
): number {
	let index = 0;
	let found = -1;
	const walk = (parent: Uuid): boolean => {
		const children = doc.fieldOrder[parent] ?? [];
		for (const childUuid of children) {
			const field = doc.fields[childUuid];
			if (!field) continue;
			if (field.id === bareId) {
				found = index;
				return true;
			}
			index++;
			if (walk(childUuid)) return true;
		}
		return false;
	};
	walk(formUuid);
	return found;
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
				if (typeof input.moduleIndex === "number") {
					latestToolScope = { moduleIndex: input.moduleIndex };
					if (typeof input.formIndex === "number") {
						latestToolScope.formIndex = input.formIndex;

						const rawRef = input.questionPath ?? input.questionId ?? input.path;
						const qRef = typeof rawRef === "string" ? rawRef : undefined;
						if (typeof qRef === "string" && qRef) {
							/* Resolve the field's flat index within its form by
							 * walking the doc's normalized entity maps directly —
							 * no wire-shape assembly needed. */
							const doc = docStoreRef.current?.getState();
							const moduleId = doc?.moduleOrder[input.moduleIndex as number];
							const formId = moduleId
								? doc?.formOrder[moduleId]?.[input.formIndex as number]
								: undefined;
							if (doc && formId) {
								const bareId = qpathId(qRef as QuestionPath);
								const flatIdx = flatIndexInForm(doc, formId, bareId);
								if (flatIdx >= 0) latestToolScope.questionIndex = flatIdx;
							}
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
		if (doc && derivePostBuildEdit(s.events, docHasData(doc))) {
			/* computeEditFocus needs the blueprint's ordering maps to
			 * convert scope indices into a 0–1 focus range. */
			controller.setEditFocus(
				computeEditFocus(
					{
						moduleOrder: doc.moduleOrder,
						formOrder: doc.formOrder,
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
