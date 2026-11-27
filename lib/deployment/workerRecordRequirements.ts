export {
	type WorkerRecordRequirement,
	workerRecordRequirements,
} from "@/lib/domain/workerRecordRequirements";

/**
 * The words every surface uses for the worker's own record: the
 * `worker-record-access` preflight edge and the setup artifact's
 * `worker-record` section. Whether the project space's plan includes worker
 * records is asked separately, as a plan feature the person confirms.
 */
export const workerRecordSetup = {
	title: "The worker's own record",
	detail:
		"These parts of the app use the worker's own CommCare record. A sync brings the record to the phone.",
	consequences:
		"Without that record, reads can be blank and forms that save to it cannot open. Preview supplies the record and does not establish that it exists on a device.",
};
