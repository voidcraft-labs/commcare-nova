// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { FieldSpec } from "@/lib/__tests__/docHelpers";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { engineFixtureInput } from "@/lib/preview/engine/__tests__/fixtures/engineInput";
import { androidDevice } from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
import { EngineController } from "@/lib/preview/engine/engineController";
import { createInProcessXPathWorkerFactory } from "@/lib/preview/xpath/inProcessWorkerClient";
import { XPathRuntime } from "@/lib/preview/xpath/workerClient";
import { BuilderSessionProvider } from "@/lib/session/provider";
import { useFormPaging } from "../useFormPaging";

const engineContext = vi.hoisted(() => ({
	controller: undefined as EngineController | undefined,
}));
vi.mock("@/lib/preview/hooks/useEngineController", () => ({
	useEngineController: () => engineContext.controller,
}));

const FORM = testUuid("paging-date-form");

it.each(["screens", "sections"] as const)(
	"resolves Android %s navigation after the date answer reveals a required question",
	async (mode) => {
		const sectioned = mode === "sections";
		const datePath = sectioned ? "/data/first/arrival" : "/data/arrival";
		const dateUuid = testUuid(
			sectioned ? "form.first.arrival" : "form.arrival",
		);
		const requiredPath = sectioned ? "/data/second/notes" : "/data/notes";
		const questions: FieldSpec[] = [
			{ kind: "date", id: "arrival", label: "Arrival" },
			{
				kind: "text",
				id: "notes",
				label: "Visit notes",
				relevant: `${datePath} != ''`,
				required: "true()",
			},
			{ kind: "text", id: "end_note", label: "End note" },
		];
		const fields = sectioned
			? ["first", "second", "third"].map((id, index) => ({
					kind: "section" as const,
					id,
					label: id,
					children: [questions[index]],
				}))
			: questions;
		const docStore = createBlueprintDocStore();
		docStore.getState().load(
			engineFixtureInput(fields, {
				formUuid: FORM,
				formType: "survey",
			}).doc,
		);
		const controller = new EngineController(
			new XPathRuntime({
				workerFactory: createInProcessXPathWorkerFactory(),
			}),
		);
		engineContext.controller = controller;
		const revealInvalid = vi.fn();
		const refuse = vi.fn();
		let unmount: (() => void) | undefined;
		try {
			controller.setDocStore(docStore);
			controller.setPreviewDevice(androidDevice());
			expect(await controller.activateFormAsync(FORM)).toBe(true);
			const rendered = renderHook(
				() => useFormPaging({ formUuid: FORM, mode, revealInvalid, refuse }),
				{
					wrapper: ({ children }: PropsWithChildren) => (
						<BuilderSessionProvider>{children}</BuilderSessionProvider>
					),
				},
			);
			unmount = rendered.unmount;
			const { result } = rendered;
			await act(async () => {
				await controller.awaitSettled();
			});

			const expectedPage = sectioned ? "/data/second" : "/data/notes";
			const initialPages = result.current.pages;
			expect(initialPages).toHaveLength(2);
			expect(initialPages).not.toContainEqual(
				expect.objectContaining({ path: expectedPage }),
			);
			expect(controller.store.getState()[dateUuid]?.value).toBe("");

			await act(async () => {
				if (sectioned) await result.current.goTo(initialPages[1].uuid);
				else await result.current.goNext();
				await controller.awaitSettled();
			});

			const date = controller.store.getState()[dateUuid];
			expect(date?.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(result.current.current?.path).toBe(expectedPage);

			if (!sectioned) {
				expect(refuse).not.toHaveBeenCalled();
				await act(async () => {
					await result.current.goNext();
					await controller.awaitSettled();
				});
			}
			expect(refuse).toHaveBeenCalledOnce();
			expect(revealInvalid).toHaveBeenCalledWith(
				expect.objectContaining({ instancePath: requiredPath }),
			);
			expect(result.current.current?.path).toBe(expectedPage);
		} finally {
			unmount?.();
			controller.dispose();
			await controller.awaitSettled();
			engineContext.controller = undefined;
		}
	},
);
