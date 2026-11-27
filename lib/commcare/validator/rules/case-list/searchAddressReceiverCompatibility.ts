import {
	effectiveCaseSearchConfig,
	isVisibleSearchInput,
	type Module,
	moduleFormsReadSearch,
	moduleSearchWorkflow,
	projectSearchOf,
	SEARCH_ADDRESS_RECEIVER_MESSAGES,
	searchAddressReceiverProblem,
	type Uuid,
} from "@/lib/domain";
import { validationError } from "../../errors";

export function searchAddressReceiverCompatibility(
	module: Module,
	moduleUuid: Uuid,
) {
	const inputs = module.caseListConfig?.searchInputs ?? [];
	const projectSearch = projectSearchOf(module) !== undefined;
	return inputs.flatMap((input, index) => {
		const savedDefaultOutsideSearch =
			input.kind === "address" &&
			input.savedDefault !== undefined &&
			(moduleSearchWorkflow(module) !== "searchFirst" ||
				moduleFormsReadSearch(module) ||
				effectiveCaseSearchConfig(module)?.searchOnClear === true ||
				input.excludeFromRequest === true ||
				input.group !== undefined ||
				inputs.some(
					(receiver) =>
						isVisibleSearchInput(receiver) &&
						receiver.addressReceiver?.kind === "address" &&
						receiver.addressReceiver.source === input.uuid,
				));
		const reason =
			input.kind === "address" && projectSearch
				? "project-search"
				: savedDefaultOutsideSearch
					? "saved-default"
					: isVisibleSearchInput(input)
						? searchAddressReceiverProblem(input, inputs)
						: undefined;
		return reason === undefined
			? []
			: [
					validationError(
						"CASE_LIST_SEARCH_ADDRESS_FIELD",
						"module",
						reason === "project-search"
							? "Add the address field to a case Search screen. A Search supplied by the project space uses the inputs it defines."
							: reason === "saved-default"
								? "Keep this address field on a Search screen that opens for the worker to enter their search, with no connected fields."
								: SEARCH_ADDRESS_RECEIVER_MESSAGES[reason],
						{ moduleUuid, moduleName: module.name },
						{
							reason,
							slot: `caseListConfig.searchInputs[${index}]`,
							inputName: input.name,
							inputUuid: input.uuid,
						},
					),
				];
	});
}
