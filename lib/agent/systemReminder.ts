/**
 * The `<system_reminder>` convention — an agent-only side channel
 * inside tool results and summaries.
 *
 * A reminder carries background knowledge for the MODEL reading the
 * result (context it should hold in mind while reasoning), never
 * content for the end user: the SA prompt teaches that a reminder is
 * not to be relayed unless the user asks or it directly affects what
 * they asked for, and the MCP docs state the same contract for
 * external clients. Today's only emitter is the unwritten-property
 * fact (`summarizeBlueprint`'s closing block, `getField`'s per-field
 * note); future ambient facts — e.g. "what changed since your last
 * tool call" under concurrent editing — should ride this same wrapper
 * rather than inventing a second channel.
 *
 * Keep reminder bodies factual and calm. The channel works because
 * its contents are reliably "for your knowledge"; a reminder that
 * demands action retrains the model to treat the channel as a task
 * queue.
 */
export function systemReminder(body: string): string {
	return `<system_reminder>\n${body}\n</system_reminder>`;
}
