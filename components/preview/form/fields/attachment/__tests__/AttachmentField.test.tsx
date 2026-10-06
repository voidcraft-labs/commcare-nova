// @vitest-environment happy-dom
import {
	act,
	cleanup,
	fireEvent,
	render,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { proseText } from "@/lib/domain";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";
import { AttachmentField } from "../AttachmentField";
import {
	__resetAttachmentCoordinatorForTests,
	getOwnedStagedAttachment,
	registerAttachmentSlotPath,
	rememberOwnedStagedAttachment,
	setAttachmentEntryAuthority,
} from "../attachmentClient";

const FIELD = {
	uuid: testUuid("attachment-photo"),
	id: "photo",
	kind: "image" as const,
	label: proseText("Photo"),
};
const ENTRY = "77777777-7777-4777-8777-777777777777";
const SLOT = "stable-photo-slot";
const coordinates = { appId: "app-1", entryKey: ENTRY, slotKey: SLOT };
const attachment = {
	attachmentId: "66666666-6666-4666-8666-666666666666",
	attachmentName: "saved.png",
	originalFilename: "picked.png",
	sizeBytes: 3,
};
afterEach(async () => {
	await act(async () => {
		cleanup();
		await __resetAttachmentCoordinatorForTests();
	});
	vi.unstubAllGlobals();
});

it("retains ownership across a control remount and cleans it when the bound answer is cleared", async () => {
	const fetchBoundary = vi
		.fn()
		.mockResolvedValue(new Response(null, { status: 204 }));
	vi.stubGlobal("fetch", fetchBoundary);
	const session = createBuilderSessionStore({
		appId: "app-1",
		projectId: "project-1",
		role: "editor",
		canEdit: true,
	});
	session.getState().setPreviewing(true);
	const authority = {
		appId: "app-1",
		entryKey: ENTRY,
		formUuid: testUuid("form"),
		projectId: "project-1",
		actorUserId: "actor",
		ownerId: "actor",
		scopeEpoch: 0,
		accessPhase: "authorized" as const,
		canEdit: true,
	};
	setAttachmentEntryAuthority({
		entryKey: ENTRY,
		snapshot: authority,
		readCurrent: () => authority,
	});
	registerAttachmentSlotPath({
		...coordinates,
		fieldUuid: FIELD.uuid,
		instancePath: "/data/photo",
		captureKind: "image",
	});
	rememberOwnedStagedAttachment({
		...coordinates,
		instancePath: "/data/photo",
		attachment,
	});
	const onChangeAt = vi.fn();
	function surface(value: string) {
		return (
			<BuilderSessionContext value={session}>
				<BlueprintDocProvider appId="app-1">
					<AttachmentField
						field={FIELD}
						state={{
							path: "/data/photo",
							value,
							visible: true,
							required: false,
							valid: true,
							touched: false,
						}}
						path="/data/photo"
						appId="app-1"
						entryKey={ENTRY}
						attachmentSlotKey={SLOT}
						onChangeAt={onChangeAt}
						onBlurAt={() => {}}
						onCommitCapture={async () => false}
					/>
				</BlueprintDocProvider>
			</BuilderSessionContext>
		);
	}
	const first = render(surface(attachment.attachmentName));
	first.unmount();
	expect(getOwnedStagedAttachment(coordinates)).toMatchObject(attachment);
	expect(fetchBoundary).not.toHaveBeenCalled();
	const resumed = render(surface(attachment.attachmentName));
	expect(getOwnedStagedAttachment(coordinates)).toMatchObject(attachment);
	resumed.rerender(surface(""));
	await waitFor(() =>
		expect(fetchBoundary).toHaveBeenCalledWith(
			`/api/apps/app-1/attachments/${attachment.attachmentId}`,
			expect.objectContaining({ method: "DELETE" }),
		),
	);
	expect(getOwnedStagedAttachment(coordinates)).toBeUndefined();
	expect(onChangeAt).not.toHaveBeenCalled();
});

it("cleans a confirmed upload when answer acceptance throws before ownership is adopted", async () => {
	const requests: { url: string; method: string }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			requests.push({ url, method });
			if (method === "DELETE" || method === "PUT")
				return new Response(null, { status: 204 });
			if (url.endsWith("/attachments"))
				return Response.json({
					attachmentId: attachment.attachmentId,
					attachmentName: attachment.attachmentName,
					uploadUrl: "https://capture.test/upload",
					uploadContentType: "image/png",
					uploadHeaders: {},
				});
			if (url.endsWith(attachment.attachmentId))
				return Response.json(attachment);
			throw new Error(`Unexpected attachment request: ${method} ${url}`);
		}),
	);
	const session = createBuilderSessionStore({
		appId: "app-1",
		projectId: "project-1",
		role: "editor",
		canEdit: true,
	});
	session.getState().setPreviewing(true);
	const authority = {
		appId: "app-1",
		entryKey: ENTRY,
		formUuid: testUuid("form"),
		projectId: "project-1",
		actorUserId: "actor",
		ownerId: "actor",
		scopeEpoch: 0,
		accessPhase: "authorized" as const,
		canEdit: true,
	};
	setAttachmentEntryAuthority({
		entryKey: ENTRY,
		snapshot: authority,
		readCurrent: () => authority,
	});
	const acceptance = vi.fn(async () => {
		throw new Error("The entry could not accept this answer.");
	});
	const changed = vi.fn();
	const surface = render(
		<BuilderSessionContext value={session}>
			<BlueprintDocProvider appId="app-1">
				<AttachmentField
					field={FIELD}
					state={{
						path: "/data/photo",
						value: "",
						visible: true,
						required: false,
						valid: true,
						touched: false,
					}}
					path="/data/photo"
					appId="app-1"
					entryKey={ENTRY}
					attachmentSlotKey={SLOT}
					onChangeAt={changed}
					onBlurAt={() => {}}
					onCommitCapture={acceptance}
				/>
			</BlueprintDocProvider>
		</BuilderSessionContext>,
	);
	await act(async () => {
		fireEvent.change(surface.getByLabelText("Photo. Attach file"), {
			target: {
				files: [
					new File([new Uint8Array([1, 2, 3])], "retry.png", {
						type: "image/png",
					}),
				],
			},
		});
	});
	await waitFor(() =>
		expect(requests).toContainEqual({
			url: `/api/apps/app-1/attachments/${attachment.attachmentId}`,
			method: "DELETE",
		}),
	);
	expect(requests.map((request) => request.method)).toEqual([
		"POST",
		"PUT",
		"POST",
		"DELETE",
	]);
	expect(acceptance).toHaveBeenCalledOnce();
	expect(changed).not.toHaveBeenCalled();
	expect(getOwnedStagedAttachment(coordinates)).toBeUndefined();
	await surface.findByText(
		"That attachment couldn't be saved. Check your connection and try again.",
	);
});
