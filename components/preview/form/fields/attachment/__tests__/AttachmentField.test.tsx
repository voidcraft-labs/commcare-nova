// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureField } from "@/lib/domain";
import type { FieldState } from "@/lib/preview/engine/types";
import { AttachmentField } from "../AttachmentField";
import {
	__resetAttachmentCoordinatorForTests,
	getOwnedStagedAttachment,
	runAttachmentTask,
} from "../attachmentClient";

const { stageAttachmentMock, discardAttachmentMock, retargetAttachmentMock } =
	vi.hoisted(() => ({
		stageAttachmentMock: vi.fn(),
		discardAttachmentMock: vi.fn(),
		retargetAttachmentMock: vi.fn(),
	}));

vi.mock("@/lib/session/hooks", () => ({
	useEditMode: () => "preview" as const,
}));

vi.mock("../attachmentClient", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../attachmentClient")>();
	return {
		...actual,
		stageAttachment: stageAttachmentMock,
		discardAttachment: discardAttachmentMock,
		retargetAttachment: retargetAttachmentMock,
	};
});

const FIELD = {
	uuid: "22222222-2222-4222-8222-222222222222",
	id: "photo",
	kind: "image",
	label: "Photo",
} as CaptureField;

const EMPTY_STATE: FieldState = {
	path: "/data/photo",
	value: "",
	visible: true,
	required: false,
	valid: true,
	touched: false,
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

beforeEach(() => {
	stageAttachmentMock.mockReset();
	discardAttachmentMock.mockReset();
	retargetAttachmentMock.mockReset();
	discardAttachmentMock.mockResolvedValue(undefined);
	retargetAttachmentMock.mockResolvedValue(undefined);
	stageAttachmentMock.mockRejectedValue(new Error("network failed"));
});

afterEach(() => {
	__resetAttachmentCoordinatorForTests();
});

describe("AttachmentField", () => {
	it("resets the native input immediately so the same rejected file can retry", async () => {
		render(
			<AttachmentField
				field={FIELD}
				state={EMPTY_STATE}
				path="/data/photo"
				appId="app-1"
				entryKey="11111111-1111-4111-8111-111111111111"
				onChange={vi.fn()}
				onBlur={vi.fn()}
			/>,
		);
		const input = screen.getByLabelText("Attach file") as HTMLInputElement;
		const file = new File(["png"], "photo.png", { type: "image/png" });

		Object.defineProperty(input, "value", {
			configurable: true,
			writable: true,
			value: "C:\\fakepath\\photo.png",
		});
		fireEvent.change(input, {
			target: { files: [file] },
		});
		expect(input.value).toBe("");
		await waitFor(() => expect(stageAttachmentMock).toHaveBeenCalledTimes(1));
		await screen.findByText(/couldn't be saved/i);

		input.value = "C:\\fakepath\\photo.png";
		fireEvent.change(input, {
			target: { files: [file] },
		});
		expect(input.value).toBe("");
		await waitFor(() => expect(stageAttachmentMock).toHaveBeenCalledTimes(2));
	});

	it("serializes Clear behind earlier work anywhere in the form entry", async () => {
		const entryKey = "33333333-3333-4333-8333-333333333333";
		const blockerStarted = deferred<void>();
		const releaseBlocker = deferred<void>();
		const blocker = runAttachmentTask({
			entryKey,
			instancePath: "/data/other",
			task: async () => {
				blockerStarted.resolve();
				await releaseBlocker.promise;
			},
		});
		await blockerStarted.promise;
		const onChange = vi.fn();
		render(
			<AttachmentField
				field={FIELD}
				state={{ ...EMPTY_STATE, value: "existing.png" }}
				path="/data/photo"
				appId="app-1"
				entryKey={entryKey}
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Remove attachment" }));
		expect(onChange).not.toHaveBeenCalled();

		releaseBlocker.resolve();
		await blocker;
		await waitFor(() => expect(onChange).toHaveBeenCalledWith(""));
	});

	it("retargets a staged answer when its stable repeat instance compacts", async () => {
		stageAttachmentMock.mockResolvedValue({
			attachmentId: "44444444-4444-4444-8444-444444444444",
			attachmentName: "44444444-4444-4444-8444-444444444444.png",
			originalFilename: "photo.png",
			sizeBytes: 3,
		});
		const onChange = vi.fn();
		const { rerender } = render(
			<AttachmentField
				field={FIELD}
				state={{ ...EMPTY_STATE, path: "/data/visits[1]/photo" }}
				path="/data/visits[1]/photo"
				appId="app-1"
				entryKey="55555555-5555-4555-8555-555555555555"
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);
		const input = screen.getByLabelText("Attach file") as HTMLInputElement;
		fireEvent.change(input, {
			target: {
				files: [new File(["png"], "photo.png", { type: "image/png" })],
			},
		});
		await waitFor(() =>
			expect(onChange).toHaveBeenCalledWith(
				"44444444-4444-4444-8444-444444444444.png",
			),
		);

		rerender(
			<AttachmentField
				field={FIELD}
				state={{
					...EMPTY_STATE,
					path: "/data/visits[0]/photo",
					value: "44444444-4444-4444-8444-444444444444.png",
				}}
				path="/data/visits[0]/photo"
				appId="app-1"
				entryKey="55555555-5555-4555-8555-555555555555"
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);

		await waitFor(() =>
			expect(retargetAttachmentMock).toHaveBeenCalledWith(
				expect.objectContaining({
					appId: "app-1",
					attachmentId: "44444444-4444-4444-8444-444444444444",
					expectedInstancePath: "/data/visits[1]/photo",
					instancePath: "/data/visits[0]/photo",
				}),
			),
		);
		expect(discardAttachmentMock).not.toHaveBeenCalled();
	});

	it("drops local capture UI state when the engine clears the form externally", async () => {
		stageAttachmentMock.mockResolvedValue({
			attachmentId: "66666666-6666-4666-8666-666666666666",
			attachmentName: "66666666-6666-4666-8666-666666666666.png",
			originalFilename: "photo.png",
			sizeBytes: 3,
		});
		const onChange = vi.fn();
		const { rerender } = render(
			<AttachmentField
				field={FIELD}
				state={EMPTY_STATE}
				path="/data/photo"
				appId="app-1"
				entryKey="77777777-7777-4777-8777-777777777777"
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Attach file"), {
			target: {
				files: [new File(["png"], "photo.png", { type: "image/png" })],
			},
		});
		await waitFor(() =>
			expect(onChange).toHaveBeenCalledWith(
				"66666666-6666-4666-8666-666666666666.png",
			),
		);

		rerender(
			<AttachmentField
				field={FIELD}
				state={{
					...EMPTY_STATE,
					value: "66666666-6666-4666-8666-666666666666.png",
				}}
				path="/data/photo"
				appId="app-1"
				entryKey="77777777-7777-4777-8777-777777777777"
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);
		await screen.findByText("photo.png");
		rerender(
			<AttachmentField
				field={FIELD}
				state={EMPTY_STATE}
				path="/data/photo"
				appId="app-1"
				entryKey="77777777-7777-4777-8777-777777777777"
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);

		await screen.findByText("No file attached.");
		await waitFor(() =>
			expect(discardAttachmentMock).toHaveBeenCalledWith({
				appId: "app-1",
				attachmentId: "66666666-6666-4666-8666-666666666666",
			}),
		);
	});

	it("keeps a confirmed answer through relevance or Preview/Edit remounts", async () => {
		const entryKey = "88888888-8888-4888-8888-888888888888";
		const attachmentName = "99999999-9999-4999-8999-999999999999.png";
		stageAttachmentMock.mockResolvedValue({
			attachmentId: "99999999-9999-4999-8999-999999999999",
			attachmentName,
			originalFilename: "visit-photo.png",
			sizeBytes: 3,
		});
		const onChange = vi.fn();
		const mounted = render(
			<AttachmentField
				field={FIELD}
				state={EMPTY_STATE}
				path="/data/photo"
				appId="app-1"
				entryKey={entryKey}
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Attach file"), {
			target: {
				files: [new File(["png"], "visit-photo.png", { type: "image/png" })],
			},
		});
		await waitFor(() => expect(onChange).toHaveBeenCalledWith(attachmentName));
		mounted.rerender(
			<AttachmentField
				field={FIELD}
				state={{ ...EMPTY_STATE, value: attachmentName }}
				path="/data/photo"
				appId="app-1"
				entryKey={entryKey}
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);
		await screen.findByText("visit-photo.png");

		mounted.unmount();

		expect(discardAttachmentMock).not.toHaveBeenCalled();
		expect(
			getOwnedStagedAttachment({
				appId: "app-1",
				entryKey,
				instancePath: "/data/photo",
			}),
		).toMatchObject({ attachmentName, originalFilename: "visit-photo.png" });

		render(
			<AttachmentField
				field={FIELD}
				state={{ ...EMPTY_STATE, value: attachmentName }}
				path="/data/photo"
				appId="app-1"
				entryKey={entryKey}
				onChange={onChange}
				onBlur={vi.fn()}
			/>,
		);
		expect(await screen.findByText("visit-photo.png")).toBeDefined();
		expect(discardAttachmentMock).not.toHaveBeenCalled();
	});

	it("exposes a focusable picker, honest disabled state, and described async feedback", async () => {
		stageAttachmentMock.mockImplementation(
			({ signal }: { signal: AbortSignal }) =>
				new Promise<never>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				}),
		);
		render(
			<AttachmentField
				field={FIELD}
				state={EMPTY_STATE}
				path="/data/photo"
				appId="app-1"
				entryKey="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
				onChange={vi.fn()}
				onBlur={vi.fn()}
			/>,
		);
		const input = screen.getByLabelText("Attach file") as HTMLInputElement;
		const label = input.closest("label");
		expect(label).not.toBeNull();
		input.focus();
		expect(document.activeElement).toBe(input);
		expect(input.getAttribute("aria-describedby")).toContain(
			screen.getByRole("status").id,
		);

		fireEvent.change(input, {
			target: {
				files: [new File(["png"], "photo.png", { type: "image/png" })],
			},
		});
		await waitFor(() => expect(input.disabled).toBe(true));
		expect(label?.getAttribute("aria-disabled")).toBe("true");
		expect(label?.className).toContain("opacity-40");
		expect(screen.getByRole("status").textContent).toMatch(/attaching/i);

		__resetAttachmentCoordinatorForTests();
	});

	it("announces attachment failures and associates them with the picker", async () => {
		render(
			<AttachmentField
				field={FIELD}
				state={EMPTY_STATE}
				path="/data/photo"
				appId="app-1"
				entryKey="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
				onChange={vi.fn()}
				onBlur={vi.fn()}
			/>,
		);
		const input = screen.getByLabelText("Attach file") as HTMLInputElement;
		fireEvent.change(input, {
			target: {
				files: [new File(["png"], "photo.png", { type: "image/png" })],
			},
		});
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toMatch(/couldn't be saved/i);
		expect(input.getAttribute("aria-describedby")).toContain(alert.id);
	});
});
