import { z } from "zod";
import { uuidSchema } from "@/lib/domain/uuid";
export const rowAssigneeSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("worker"),
		appId: z.string().min(1),
		id: uuidSchema,
	}),
	z.strictObject({
		kind: z.literal("place"),
		appId: z.string().min(1),
		id: uuidSchema,
	}),
	z.strictObject({ kind: z.literal("group"), id: uuidSchema }),
]);
export type RowAssignee = z.infer<typeof rowAssigneeSchema>;
export const rowAssigneesSchema = z.array(rowAssigneeSchema).max(1000);

export const assignmentDirectorySchema = z.strictObject({
	query: z.string().max(128).optional(),
	offset: z.number().int().min(0).max(1_000_000).optional(),
	kind: z.enum(["worker", "place", "group"]).optional(),
});
export type AssignmentDirectoryQuery = z.infer<
	typeof assignmentDirectorySchema
>;
export interface NamedAssignee {
	principal: RowAssignee;
	name: string;
	appName: string | null;
}

export const targetGroupReadSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("spaces") }),
	z.strictObject({
		kind: z.literal("find"),
		groupId: uuidSchema,
		domain: z.string().min(1).max(255),
		name: z.string().min(1).max(255),
	}),
	z.strictObject({
		kind: z.literal("review"),
		groupId: uuidSchema,
		domain: z.string().min(1).max(255),
		remoteId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
	}),
]);
export const targetGroupBindingSchema = z.strictObject({
	kind: z.literal("connect"),
	groupId: uuidSchema,
	domain: z.string().min(1).max(255),
	remoteId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
	witness: z.string().regex(/^[a-f0-9]{64}$/),
});
export type TargetGroupRead = z.infer<typeof targetGroupReadSchema>;
export const workerGroupEditSchema = z.strictObject({
	operationId: z.uuid(),
	expectedProjectRevision: z.string().regex(/^(0|[1-9][0-9]*)$/),
	change: z.discriminatedUnion("kind", [
		targetGroupBindingSchema,
		z.strictObject({
			kind: z.literal("create"),
			name: z.string().trim().min(1).max(255),
			sharesCases: z.boolean(),
			metadata: z
				.array(
					z.strictObject({
						key: z.string().min(1).max(255),
						value: z.string().max(4096),
					}),
				)
				.max(100),
		}),
		z.strictObject({
			kind: z.literal("update"),
			groupId: uuidSchema,
			name: z.string().trim().min(1).max(255),
			sharesCases: z.boolean(),
			metadata: z
				.array(
					z.strictObject({
						key: z.string().min(1).max(255),
						value: z.string().max(4096),
					}),
				)
				.max(100),
		}),
		z.strictObject({
			kind: z.literal("membership"),
			groupId: uuidSchema,
			appId: z.string().min(1),
			personaId: uuidSchema,
			member: z.boolean(),
		}),
	]),
});
export type WorkerGroupEdit = z.infer<typeof workerGroupEditSchema>;

export const workerDirectoryReadSchema = z.strictObject({
	search: assignmentDirectorySchema,
	target: targetGroupReadSchema.optional(),
	groupId: uuidSchema.optional(),
	memberOffset: z.number().int().nonnegative().max(1_000_000).optional(),
});
