import type * as Actions from "@/lib/preview/engine/formOpeningAction";

export const readFormOpeningAction: typeof Actions.readFormOpeningAction =
	async () => {
		throw new Error("This browser fixture has no authenticated form opening.");
	};

export const authorizeSavedFormReceiptRun: typeof Actions.authorizeSavedFormReceiptRun =
	async () => {
		throw new Error("This browser fixture has no signed submission receipt.");
	};
