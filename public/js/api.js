// Thin HTTP client for pigui's JSON, HTML fragment, upload, and NDJSON endpoints.

export class RequestFailed extends Error {
	constructor(status, message, hint) {
		super(message);
		this.status = status;
		this.hint = hint;
	}
}

export function describeFailure(error) {
	if (error instanceof RequestFailed) return { message: error.message, hint: error.hint };
	if (error instanceof Error) return { message: error.message };
	return { message: "Something went wrong." };
}

export function newRequestId() {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function parseError(response) {
	try {
		const data = await response.json();
		if (data && typeof data.error === "string") return new RequestFailed(response.status, data.error, typeof data.hint === "string" ? data.hint : undefined);
	} catch {
		// Fall through to status text.
	}
	return new RequestFailed(response.status, response.statusText || `Request failed (${response.status}).`);
}

async function request(url, init) {
	let response;
	try {
		response = await fetch(url, init);
	} catch {
		throw new RequestFailed(0, "Could not reach pigui.", "Check the connection and try again.");
	}
	if (!response.ok) throw await parseError(response);
	return response;
}

export async function getJson(url, signal) {
	const response = await request(url, { headers: { Accept: "application/json" }, signal });
	return response.json();
}

export async function postJson(url, body, signal) {
	const response = await request(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: body === undefined ? "{}" : JSON.stringify(body),
		signal,
	});
	return response.json();
}

export async function getHtml(url, signal) {
	const response = await request(url, { headers: { Accept: "text/html" }, signal });
	return response.text();
}

export async function uploadFile(blob, name) {
	const response = await request("/api/uploads", {
		method: "POST",
		headers: {
			"Content-Type": blob.type || "application/octet-stream",
			"X-Filename": encodeURIComponent(name),
		},
		body: blob,
	});
	return response.json();
}

export async function postAudio(url, body, signal) {
	const response = await request(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	return response.blob();
}

export async function* streamLines(url, body, signal) {
	const response = await request(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	if (!response.body) return;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const parts = buffer.split("\n");
			buffer = parts.pop() ?? "";
			for (const line of parts) {
				if (line.trim() !== "") yield JSON.parse(line);
			}
		}
		if (buffer.trim() !== "") yield JSON.parse(buffer);
	} finally {
		reader.releaseLock();
	}
}
