// components/builder/shared/cards/expression/OwnerValueCards.tsx
//
// Case-operation owner sentinels are authored by the future operation editor.
// The generic expression editor preserves them without exposing them as ordinary
// replacement choices.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerUser from "@iconify-icons/tabler/user";
import tablerUserOff from "@iconify-icons/tabler/user-off";
import {
	actingUser,
	unowned,
	type ValueExpression,
} from "@/lib/domain/predicate";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import type { EditorPath } from "../../path";

export function actingUserDefault(
	_ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "acting-user" }> {
	return actingUser();
}

export function unownedDefault(
	_ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "unowned" }> {
	return unowned();
}

interface OwnerValueCardProps<K extends "acting-user" | "unowned"> {
	readonly value: Extract<ValueExpression, { kind: K }>;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
}

export function ActingUserCard(_props: OwnerValueCardProps<"acting-user">) {
	return (
		<div className="flex items-center gap-2 rounded-lg border border-dashed border-white/[0.06] bg-nova-surface/20 px-3 py-2.5">
			<Icon
				icon={tablerUser}
				width="14"
				height="14"
				className="text-nova-violet-bright"
			/>
			<div className="text-[13px] leading-relaxed text-nova-text">
				Assigns the case to the person using the app
			</div>
		</div>
	);
}

export function UnownedCard(_props: OwnerValueCardProps<"unowned">) {
	return (
		<div className="flex items-center gap-2 rounded-lg border border-dashed border-white/[0.06] bg-nova-surface/20 px-3 py-2.5">
			<Icon
				icon={tablerUserOff}
				width="14"
				height="14"
				className="text-nova-violet-bright"
			/>
			<div className="text-[13px] leading-relaxed text-nova-text">
				Leaves the case without an owner
			</div>
		</div>
	);
}
