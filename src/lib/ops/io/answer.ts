/**
 * Answering a chart's send from an ops I/O processor. `send.answer` may be
 * called once; a processor whose work answers from its `try` and again from
 * its `catch` (an error after the answer) keeps the first answer. An answer
 * to a sender that ended meanwhile is dropped; one after the ops host closed
 * (shutdown) too.
 */
import type { Send, Value } from '@tinyactors/node';

export function answerOnce(send: Send): (event: string, data?: unknown) => void {
	let answered = false;
	return (event, data) => {
		if (answered) return;
		answered = true;
		try {
			send.answer(event, data as Value);
		} catch {
			/* the ops host closed */
		}
	};
}
