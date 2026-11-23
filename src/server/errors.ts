/** A refusal the person can act on: an HTTP status, what went wrong, and what to do next. */
export class HttpError extends Error {
	readonly status: number;
	readonly hint: string | undefined;

	constructor(status: number, message: string, hint?: string) {
		super(message);
		this.name = "HttpError";
		this.status = status;
		this.hint = hint;
	}
}

export const notFound = (what: string): HttpError => new HttpError(404, `${what} was not found.`);
