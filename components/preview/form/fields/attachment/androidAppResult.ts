import type { Platform } from "@/lib/domain/platforms";
import type { AndroidAppReturn } from "@/lib/preview/engine/androidAppReturn";
import type { EngineController } from "@/lib/preview/engine/engineController";
import {
	forgetOwnedStagedAttachment,
	getOwnedStagedAttachment,
	registerAttachmentSlotPath,
	rememberOwnedStagedAttachment,
	resolveAttachmentSlotKey,
	runAttachmentTargets,
	type StagedAttachment,
	scheduleAttachmentCleanup,
	stageAttachment,
} from "./attachmentClient";

/** All files are privately staged before the result's answers become visible.
 * A changed entry, row, mapping, rejected file, or cancellation releases only
 * this attempt's bytes. The ordinary capture store owns every accepted file. */
export async function applyAndroidAppResult(
	controller: EngineController,
	appId: string,
	entryKey: string,
	path: string,
	signature: string,
	result: AndroidAppReturn,
	platform: Platform,
	signal: AbortSignal,
): Promise<boolean> {
	const writes = controller.androidAppResult(entryKey, path, signature, result);
	if (!writes || signal.aborted) return false;
	const captures = writes.filter((write) => write.kind === "capture");
	if (!captures.length)
		return controller.commitAndroidAppResult(
			entryKey,
			path,
			signature,
			result,
			new Map(),
			() => {},
		);
	const targets = new Map(
		captures.map((write) => {
			const slotKey = resolveAttachmentSlotKey({
				appId,
				entryKey,
				requestedSlotKey: write.slotKey,
				fieldUuid: write.field,
				instancePath: write.path,
			});
			return [
				write.path,
				{ slotKey, fieldUuid: write.field, instancePath: write.path },
			] as const;
		}),
	);
	return runAttachmentTargets(
		entryKey,
		new Map([...targets.values()].map((target) => [target.slotKey, target])),
		async (task) => {
			const guard = AbortSignal.any([signal, task.signal]);
			const pending = new Map<
				string,
				{ slotKey: string; attachment: StagedAttachment | undefined }
			>();
			const uploaded: StagedAttachment[] = [];
			const adopted = new Set<string>();
			try {
				for (const write of captures) {
					if (guard.aborted || !task.isCurrent()) return false;
					const target = targets.get(write.path);
					if (!target) return false;
					const { slotKey } = target;
					const attachment = write.file
						? await stageAttachment({
								appId,
								entryKey,
								fieldUuid: write.field,
								instancePath: write.path,
								file: write.file,
								platform,
								signal: guard,
							})
						: undefined;
					if (attachment) uploaded.push(attachment);
					pending.set(write.path, { slotKey, attachment });
				}
				if (guard.aborted || !task.isCurrent()) return false;
				const names = new Map(
					[...pending].map(([target, item]) => [
						target,
						item.attachment?.attachmentName ?? "",
					]),
				);
				return await controller.commitAndroidAppResult(
					entryKey,
					path,
					signature,
					result,
					names,
					() => {
						for (const write of captures) {
							const next = pending.get(write.path);
							if (!next) continue;
							pending.delete(write.path);
							const { slotKey, attachment } = next;
							const identity = { appId, entryKey, slotKey };
							const previous = getOwnedStagedAttachment(identity);
							registerAttachmentSlotPath({
								...identity,
								fieldUuid: write.field,
								instancePath: write.path,
								captureKind: write.captureKind,
							});
							if (attachment) {
								rememberOwnedStagedAttachment({
									...identity,
									instancePath: write.path,
									attachment,
									maximumDraftGeneration: task.generationFor(slotKey),
								});
								adopted.add(attachment.attachmentId);
							} else forgetOwnedStagedAttachment(identity);
							if (
								previous &&
								previous.attachmentId !== attachment?.attachmentId
							)
								scheduleAttachmentCleanup({
									appId,
									attachmentId: previous.attachmentId,
								});
						}
					},
				);
			} finally {
				for (const attachment of uploaded) {
					if (!adopted.has(attachment.attachmentId))
						scheduleAttachmentCleanup({
							appId,
							attachmentId: attachment.attachmentId,
						});
				}
			}
		},
	);
}
