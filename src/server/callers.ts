// Who opened a connection. On a server, pigui listens on loopback so that only `tailscale serve` reaches it, and
// trusts the Tailscale identity header it adds. The agent's commands share that loopback and could send the same
// header, so a connection opened by a process running as pigui's own user, as the agent's commands do, is refused.
// Tailscale runs as another user (root) in both deployments. pigui OnPrem turns this around: the person's browser
// runs as pigui's own user, so that user gets in, and root, which is how tailscale serve arrives and which could
// read everything pigui holds anyway; other users of a shared computer are refused. The kernel's socket table says
// which user owns the other end; it lives in procfs, so this check is Linux-only. Elsewhere (macOS, the BSDs) the
// table is absent and OnPrem checks no caller.
import { readFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { endianness } from "node:os";
import type { Socket } from "node:net";

type Endpoint = { address: string; port: number };

/** An address as the kernel's socket table prints it: each 32-bit word in the machine's byte order, then the port. */
function tableKey(endpoint: Endpoint): string | undefined {
	const port = endpoint.port.toString(16).toUpperCase().padStart(4, "0");
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(endpoint.address)?.[1];
	const address = mapped ?? endpoint.address;
	const bytes = isIPv4(address) ? address.split(".").map(Number) : ipv6Bytes(address);
	if (bytes === undefined) return undefined;
	const words: string[] = [];
	for (let at = 0; at < bytes.length; at += 4) {
		const word = bytes.slice(at, at + 4);
		if (endianness() === "LE") word.reverse();
		words.push(word.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(""));
	}
	return `${words.join("")}:${port}`;
}

function ipv6Bytes(address: string): number[] | undefined {
	const pieces = address.split("::");
	if (pieces.length > 2) return undefined;
	const [head = "", tail = ""] = pieces;
	const groups = (part: string) => (part === "" ? [] : part.split(":"));
	const left = groups(head);
	const right = groups(tail);
	if (!address.includes("::") && left.length !== 8) return undefined;
	if (left.length + right.length > 8) return undefined;
	const all = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
	if (all.length !== 8 || all.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return undefined;
	return all.flatMap((group) => {
		const value = Number.parseInt(group, 16);
		return [value >> 8, value & 0xff];
	});
}

/**
 * The user ID owning the client end of a connection, from a socket table's text (`/proc/net/tcp` or `tcp6`): the row
 * whose local end is the client's address and whose remote end is the server's.
 */
export function clientOwner(table: string, client: Endpoint, server: Endpoint): number | undefined {
	const local = tableKey(client);
	const remote = tableKey(server);
	if (local === undefined || remote === undefined) return undefined;
	for (const line of table.split("\n").slice(1)) {
		const fields = line.trim().split(/\s+/);
		if (fields[1] === local && fields[2] === remote) {
			const uid = Number(fields[7]);
			// A row without a uid must not produce a NaN owner, which server-mode admission would treat as a stranger.
			return Number.isInteger(uid) && uid >= 0 ? uid : undefined;
		}
	}
	return undefined;
}

/**
 * Whether the user `owner` may use pigui running as `own`: on a server (`others`), anyone but pigui's own user; in
 * OnPrem (`own`), pigui's own user and root (tailscaled).
 */
export function admits(allow: "others" | "own", owner: number, own: number): boolean {
	return allow === "own" ? owner === own || owner === 0 : owner !== own;
}

/**
 * Whether a connection may use pigui, by `admits`. Refused when the owner cannot be told, since a caller that cannot
 * be identified cannot be trusted.
 */
export function callerCheck(allow: "others" | "own"): (socket: Socket) => Promise<boolean> {
	const verdicts = new WeakMap<Socket, Promise<boolean>>();
	const own = process.getuid?.();
	const decide = async (socket: Socket): Promise<boolean> => {
		const { remoteAddress, remotePort, localAddress, localPort } = socket;
		if (own === undefined || remoteAddress === undefined || remotePort === undefined || localAddress === undefined || localPort === undefined) return false;
		const file = isIPv4(remoteAddress) ? "/proc/net/tcp" : "/proc/net/tcp6";
		const table = await readFile(file, "utf8").catch(() => "");
		const owner = clientOwner(table, { address: remoteAddress, port: remotePort }, { address: localAddress, port: localPort });
		return owner !== undefined && admits(allow, owner, own);
	};
	return (socket) => {
		let verdict = verdicts.get(socket);
		if (verdict === undefined) {
			verdict = decide(socket);
			verdicts.set(socket, verdict);
		}
		return verdict;
	};
}
