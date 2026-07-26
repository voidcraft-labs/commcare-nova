// @vitest-environment happy-dom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetAttachmentCoordinatorForTests,
	runAttachmentTask,
	runFormAttachmentBarrier,
} from "../attachmentClient";
import { SignaturePad } from "../SignaturePad";

const context = {
	setTransform: vi.fn(),
	clearRect: vi.fn(),
	beginPath: vi.fn(),
	moveTo: vi.fn(),
	lineTo: vi.fn(),
	stroke: vi.fn(),
	lineWidth: 0,
	lineCap: "round",
	lineJoin: "round",
	strokeStyle: "",
} as unknown as CanvasRenderingContext2D;

let blobCallbacks: BlobCallback[] = [];

beforeEach(() => {
	blobCallbacks = [];
	vi.useFakeTimers();
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
	vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
		(callback) => {
			blobCallbacks.push(callback);
		},
	);
});

afterEach(() => {
	__resetAttachmentCoordinatorForTests();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function drawOneStroke(
	canvas: HTMLCanvasElement,
	pointerId: number,
): Promise<void> {
	Object.assign(canvas, {
		setPointerCapture: vi.fn(),
		releasePointerCapture: vi.fn(),
	});
	fireEvent.pointerDown(canvas, {
		pointerId,
		clientX: 10,
		clientY: 10,
	});
	fireEvent.pointerUp(canvas, {
		pointerId,
		clientX: 10,
		clientY: 10,
	});
	await act(async () => {
		for (let index = 0; index < 5; index++) await Promise.resolve();
		vi.advanceTimersByTime(800);
		for (let index = 0; index < 5; index++) await Promise.resolve();
	});
}

describe("SignaturePad", () => {
	it("keeps the latest ink blocked and drawable when its stable repeat instance compacts", async () => {
		const onDrawn = vi.fn();
		const view = render(
			<SignaturePad
				entryKey="entry-repeat"
				instancePath="/data/visits[1]/signature"
				uploading={false}
				hasAnswer={true}
				onDrawn={onDrawn}
				onClear={vi.fn()}
			/>,
		);
		const canvas = screen.getByLabelText(/Signature pad/) as HTMLCanvasElement;
		Object.assign(canvas, {
			setPointerCapture: vi.fn(),
			releasePointerCapture: vi.fn(),
		});

		// Establish the older confirmed PNG.
		await drawOneStroke(canvas, 1);
		await act(async () => {
			blobCallbacks[0]?.(new Blob(["old"], { type: "image/png" }));
			await Promise.resolve();
		});
		expect(onDrawn).toHaveBeenCalledTimes(1);

		// The latest visible stroke is still inside its queued debounce when
		// deleting row 1 compacts this stable row from [1] to [0].
		fireEvent.pointerDown(canvas, {
			pointerId: 2,
			clientX: 20,
			clientY: 20,
		});
		fireEvent.pointerUp(canvas, {
			pointerId: 2,
			clientX: 20,
			clientY: 20,
		});
		view.rerender(
			<SignaturePad
				entryKey="entry-repeat"
				instancePath="/data/visits[0]/signature"
				uploading={false}
				hasAnswer={true}
				onDrawn={onDrawn}
				onClear={vi.fn()}
			/>,
		);

		const submit = vi.fn();
		const barrier = runFormAttachmentBarrier("entry-repeat", async () => {
			submit();
		});
		await act(async () => {
			await Promise.resolve();
		});
		expect(submit).not.toHaveBeenCalled();
		expect(
			(
				screen.getByRole("button", {
					name: "Clear signature",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);

		await act(async () => {
			vi.advanceTimersByTime(700);
			await Promise.resolve();
		});
		expect(blobCallbacks).toHaveLength(2);
		await act(async () => {
			blobCallbacks[1]?.(new Blob(["latest"], { type: "image/png" }));
			await Promise.resolve();
			await barrier;
		});
		expect(onDrawn).toHaveBeenCalledTimes(2);
		expect(submit).toHaveBeenCalledTimes(1);
	});

	it("generation-fences an older toBlob callback after a newer stroke", async () => {
		const onDrawn = vi.fn();
		render(
			<SignaturePad
				entryKey="entry-a"
				instancePath="/data/signature"
				uploading={false}
				hasAnswer={false}
				onDrawn={onDrawn}
				onClear={vi.fn()}
			/>,
		);
		const canvas = screen.getByLabelText(/Signature pad/) as HTMLCanvasElement;

		await drawOneStroke(canvas, 1);
		expect(blobCallbacks).toHaveLength(1);
		await drawOneStroke(canvas, 2);
		expect(blobCallbacks).toHaveLength(2);

		blobCallbacks[0]?.(new Blob(["old"], { type: "image/png" }));
		expect(onDrawn).not.toHaveBeenCalled();
		await act(async () => {
			blobCallbacks[1]?.(new Blob(["new"], { type: "image/png" }));
			await Promise.resolve();
		});
		expect(onDrawn).toHaveBeenCalledTimes(1);
	});

	it("invalidates an in-flight canvas render when the signature is cleared", async () => {
		const onDrawn = vi.fn();
		const onClear = vi.fn();
		render(
			<SignaturePad
				entryKey="entry-a"
				instancePath="/data/signature"
				uploading={true}
				hasAnswer={false}
				onDrawn={onDrawn}
				onClear={onClear}
			/>,
		);
		const canvas = screen.getByLabelText(/Signature pad/) as HTMLCanvasElement;

		await drawOneStroke(canvas, 1);
		fireEvent.click(screen.getByRole("button", { name: "Clear signature" }));
		blobCallbacks[0]?.(new Blob(["stale"], { type: "image/png" }));

		expect(onClear).toHaveBeenCalledTimes(1);
		expect(onDrawn).not.toHaveBeenCalled();
	});

	it("registers debounce and canvas encoding in the form queue immediately", async () => {
		const saved = deferred<void>();
		const onDrawn = vi.fn(async () => {
			await saved.promise;
		});
		render(
			<SignaturePad
				entryKey="entry-queue"
				instancePath="/data/signature"
				uploading={false}
				hasAnswer={false}
				onDrawn={onDrawn}
				onClear={vi.fn()}
			/>,
		);
		const canvas = screen.getByLabelText(/Signature pad/) as HTMLCanvasElement;
		Object.assign(canvas, {
			setPointerCapture: vi.fn(),
			releasePointerCapture: vi.fn(),
		});

		fireEvent.pointerDown(canvas, {
			pointerId: 1,
			clientX: 10,
			clientY: 10,
		});
		fireEvent.pointerUp(canvas, {
			pointerId: 1,
			clientX: 10,
			clientY: 10,
		});
		const submit = vi.fn();
		const barrier = runFormAttachmentBarrier("entry-queue", async () => {
			submit();
		});

		await act(async () => {
			await Promise.resolve();
		});
		expect(submit).not.toHaveBeenCalled();
		expect(onDrawn).not.toHaveBeenCalled();

		await act(async () => {
			vi.advanceTimersByTime(700);
		});
		expect(blobCallbacks).toHaveLength(1);
		await act(async () => {
			blobCallbacks[0]?.(new Blob(["ink"], { type: "image/png" }));
			await Promise.resolve();
		});
		expect(onDrawn).toHaveBeenCalledTimes(1);
		expect(submit).not.toHaveBeenCalled();

		saved.resolve();
		await act(async () => {
			await barrier;
		});
		expect(submit).toHaveBeenCalledTimes(1);
	});

	it("announces queued ink before it can run behind another capture", async () => {
		const blockerStarted = deferred<void>();
		const blockerRelease = deferred<void>();
		const blocker = runAttachmentTask({
			entryKey: "entry-queued-signature",
			instancePath: "/data/photo",
			task: async () => {
				blockerStarted.resolve();
				await blockerRelease.promise;
			},
		});
		await blockerStarted.promise;
		render(
			<SignaturePad
				entryKey="entry-queued-signature"
				instancePath="/data/signature"
				uploading={false}
				hasAnswer={false}
				onDrawn={vi.fn()}
				onClear={vi.fn()}
			/>,
		);
		const canvas = screen.getByLabelText(/Signature pad/) as HTMLCanvasElement;
		Object.assign(canvas, {
			setPointerCapture: vi.fn(),
			releasePointerCapture: vi.fn(),
		});

		fireEvent.pointerDown(canvas, {
			pointerId: 1,
			clientX: 10,
			clientY: 10,
		});
		fireEvent.pointerUp(canvas, {
			pointerId: 1,
			clientX: 10,
			clientY: 10,
		});

		expect(screen.getByRole("status").textContent).toMatch(
			/waiting to save signature/i,
		);
		expect(screen.getAllByRole("status")).toHaveLength(1);

		await act(async () => {
			blockerRelease.resolve();
			await blocker;
			await Promise.resolve();
			__resetAttachmentCoordinatorForTests();
			await Promise.resolve();
		});
	});

	it("guards clear and draw gestures while a destructive clear is queued", () => {
		const onClear = vi.fn();
		const onDrawn = vi.fn();
		render(
			<SignaturePad
				entryKey="entry-queued-clear"
				instancePath="/data/signature"
				uploading={false}
				interactionBlocked
				hasAnswer={true}
				onDrawn={onDrawn}
				onClear={onClear}
			/>,
		);
		const canvas = screen.getByLabelText(/Signature pad/) as HTMLCanvasElement;
		fireEvent.pointerDown(canvas, {
			pointerId: 1,
			clientX: 10,
			clientY: 10,
		});
		fireEvent.pointerUp(canvas, {
			pointerId: 1,
			clientX: 10,
			clientY: 10,
		});
		const clear = screen.getByRole("button", {
			name: "Clear signature",
		}) as HTMLButtonElement;
		fireEvent.click(clear);

		expect(clear.disabled).toBe(true);
		expect(onClear).not.toHaveBeenCalled();
		expect(onDrawn).not.toHaveBeenCalled();
		expect(blobCallbacks).toHaveLength(0);
		expect(screen.getByRole("status").textContent).toMatch(
			/waiting to clear signature/i,
		);
	});

	it("keeps signature pixels entry-local across a persona/entry switch", async () => {
		const onDrawn = vi.fn();
		const { rerender } = render(
			<SignaturePad
				entryKey="entry-persona-a"
				instancePath="/data/signature"
				uploading={false}
				hasAnswer={false}
				onDrawn={onDrawn}
				onClear={vi.fn()}
			/>,
		);
		const canvas = screen.getByLabelText(/Signature pad/) as HTMLCanvasElement;
		await drawOneStroke(canvas, 1);
		expect(
			(
				screen.getByRole("button", {
					name: "Clear signature",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);

		rerender(
			<SignaturePad
				entryKey="entry-persona-b"
				instancePath="/data/signature"
				uploading={false}
				hasAnswer={false}
				onDrawn={onDrawn}
				onClear={vi.fn()}
			/>,
		);

		expect(
			(
				screen.getByRole("button", {
					name: "Clear signature",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		blobCallbacks[0]?.(new Blob(["persona-a"], { type: "image/png" }));
		expect(onDrawn).not.toHaveBeenCalled();
	});

	it("keeps submission blocked when canvas encoding returns null", async () => {
		const onEncodingError = vi.fn();
		render(
			<SignaturePad
				entryKey="entry-null"
				instancePath="/data/signature"
				uploading={false}
				hasAnswer={false}
				onDrawn={vi.fn()}
				onClear={vi.fn()}
				onEncodingError={onEncodingError}
			/>,
		);
		const canvas = screen.getByLabelText(/Signature pad/) as HTMLCanvasElement;
		await drawOneStroke(canvas, 1);
		await act(async () => {
			blobCallbacks[0]?.(null);
			await Promise.resolve();
		});

		expect(onEncodingError).toHaveBeenCalledWith(
			expect.stringMatching(/couldn't be saved/i),
		);
		await expect(
			runFormAttachmentBarrier("entry-null", async () => "submitted"),
		).rejects.toThrow(/signature/i);
	});

	it("settles the latest ink after pointer cancellation", async () => {
		const onDrawn = vi.fn();
		render(
			<SignaturePad
				entryKey="entry-cancel"
				instancePath="/data/signature"
				uploading={false}
				hasAnswer={false}
				onDrawn={onDrawn}
				onClear={vi.fn()}
			/>,
		);
		const canvas = screen.getByLabelText(/Signature pad/) as HTMLCanvasElement;
		Object.assign(canvas, {
			setPointerCapture: vi.fn(),
			releasePointerCapture: vi.fn(),
		});
		fireEvent.pointerDown(canvas, {
			pointerId: 1,
			clientX: 10,
			clientY: 10,
		});
		fireEvent.pointerCancel(canvas, { pointerId: 1 });
		await act(async () => {
			await Promise.resolve();
			vi.advanceTimersByTime(700);
			await Promise.resolve();
		});
		expect(blobCallbacks).toHaveLength(1);
		await act(async () => {
			blobCallbacks[0]?.(new Blob(["ink"], { type: "image/png" }));
			await Promise.resolve();
		});
		expect(onDrawn).toHaveBeenCalledTimes(1);
	});

	it("rescales retained ink when the pad narrows before another stroke", async () => {
		let width = 200;
		vi.spyOn(
			HTMLCanvasElement.prototype,
			"getBoundingClientRect",
		).mockImplementation(
			() =>
				({
					width,
					height: 160,
					left: 0,
					top: 0,
					right: width,
					bottom: 160,
					x: 0,
					y: 0,
					toJSON: () => ({}),
				}) as DOMRect,
		);
		const onDrawn = vi.fn();
		render(
			<SignaturePad
				entryKey="entry-responsive"
				instancePath="/data/signature"
				uploading={false}
				hasAnswer={false}
				onDrawn={onDrawn}
				onClear={vi.fn()}
			/>,
		);
		const canvas = screen.getByLabelText(/Signature pad/) as HTMLCanvasElement;
		Object.assign(canvas, {
			setPointerCapture: vi.fn(),
			releasePointerCapture: vi.fn(),
		});
		fireEvent.pointerDown(canvas, {
			pointerId: 1,
			clientX: 180,
			clientY: 80,
		});
		fireEvent.pointerUp(canvas, {
			pointerId: 1,
			clientX: 180,
			clientY: 80,
		});

		width = 100;
		vi.mocked(context.moveTo).mockClear();
		fireEvent(window, new Event("resize"));
		expect(context.moveTo).toHaveBeenCalledWith(90, 80);

		fireEvent.pointerDown(canvas, {
			pointerId: 2,
			clientX: 50,
			clientY: 100,
		});
		fireEvent.pointerUp(canvas, {
			pointerId: 2,
			clientX: 50,
			clientY: 100,
		});
		await act(async () => {
			vi.advanceTimersByTime(700);
			await Promise.resolve();
		});
		// Continuing the signature must retain the rescaled first stroke.
		expect(context.moveTo).toHaveBeenCalledWith(90, 80);
		expect(context.moveTo).toHaveBeenCalledWith(50, 100);
	});

	it("fences a pre-resize PNG and re-encodes the resized signature", async () => {
		let width = 200;
		vi.spyOn(
			HTMLCanvasElement.prototype,
			"getBoundingClientRect",
		).mockImplementation(
			() =>
				({
					width,
					height: 160,
					left: 0,
					top: 0,
					right: width,
					bottom: 160,
					x: 0,
					y: 0,
					toJSON: () => ({}),
				}) as DOMRect,
		);
		const onDrawn = vi.fn();
		render(
			<SignaturePad
				entryKey="entry-resize-fence"
				instancePath="/data/signature"
				uploading={false}
				hasAnswer={false}
				onDrawn={onDrawn}
				onClear={vi.fn()}
			/>,
		);
		const canvas = screen.getByLabelText(/Signature pad/) as HTMLCanvasElement;
		await drawOneStroke(canvas, 1);
		expect(blobCallbacks).toHaveLength(1);

		width = 100;
		fireEvent(window, new Event("resize"));
		await act(async () => {
			vi.advanceTimersByTime(0);
			for (let index = 0; index < 5; index++) await Promise.resolve();
		});
		expect(blobCallbacks).toHaveLength(2);
		const submit = vi.fn();
		const barrier = runFormAttachmentBarrier("entry-resize-fence", async () => {
			submit();
		});

		blobCallbacks[0]?.(new Blob(["stale-wide"], { type: "image/png" }));
		expect(onDrawn).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
		await act(async () => {
			blobCallbacks[1]?.(new Blob(["fresh-narrow"], { type: "image/png" }));
			await barrier;
		});
		expect(onDrawn).toHaveBeenCalledTimes(1);
		expect(submit).toHaveBeenCalledTimes(1);
	});

	it("keeps the first clear undoable when Clear is tapped twice before its queued answer update", async () => {
		const onClear = vi.fn();
		render(
			<SignaturePad
				entryKey="entry-double-clear"
				instancePath="/data/signature"
				uploading={false}
				hasAnswer={true}
				onDrawn={vi.fn()}
				onClear={onClear}
			/>,
		);
		const canvas = screen.getByLabelText(/Signature pad/) as HTMLCanvasElement;
		Object.assign(canvas, {
			setPointerCapture: vi.fn(),
			releasePointerCapture: vi.fn(),
		});
		fireEvent.pointerDown(canvas, {
			pointerId: 1,
			clientX: 10,
			clientY: 10,
		});
		fireEvent.pointerUp(canvas, {
			pointerId: 1,
			clientX: 10,
			clientY: 10,
		});

		const clear = screen.getByRole("button", { name: "Clear signature" });
		fireEvent.click(clear);
		fireEvent.click(clear);

		expect(onClear).toHaveBeenCalledTimes(1);
		expect(screen.getByRole("button", { name: "Undo" })).toBeDefined();
	});

	it("can clear a saved signature even when this entry has no local pixel draft", () => {
		const onClear = vi.fn();
		render(
			<SignaturePad
				entryKey="entry-preloaded-answer"
				instancePath="/data/signature"
				uploading={false}
				hasAnswer={true}
				onDrawn={vi.fn()}
				onClear={onClear}
			/>,
		);

		const clear = screen.getByRole("button", {
			name: "Clear signature",
		}) as HTMLButtonElement;
		expect(clear.disabled).toBe(false);
		fireEvent.click(clear);
		fireEvent.click(clear);

		expect(onClear).toHaveBeenCalledTimes(1);
		expect(clear.disabled).toBe(true);
	});
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}
