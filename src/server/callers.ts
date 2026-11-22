// Who opened a connection. picloud listens on loopback so that only `tailscale serve` reaches it, and trusts the
// Tailscale identity header it adds. The agent's commands share that loopback and could send the same header, so a
// connection opened by a process running as picloud's own user, as the agent's commands do, is refused. Tailscale
// runs as another user (root) in both deployments. The kernel's socket table says which user owns the other end.
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
	const [head = "", tail = ""] = address.split("::");
	const groups = (part: string) => (part === "" ? [] : part.split(":"));
	const left = groups(head);
	const right = groups(tail);
	if (!address.includes("::") && left.length !== 8) return undefined;
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
		if (fields[1] === local && fields[2] === remote) return Number(fields[7]);
	}
	return undefined;
}

/**
 * Whether a connection may use picloud: refused when its other end belongs to picloud's own user, or cannot be told,
 * since a caller that cannot be identified cannot be trusted with the identity header either.
 */
export function callerCheck(): (socket: Socket) => Promise<boolean> {
	const verdicts = new WeakMap<Socket, Promise<boolean>>();
	const own = process.getuid?.();
	const decide = async (socket: Socket): Promise<boolean> => {
		const { remoteAddress, remotePort, localAddress, localPort } = socket;
		if (own === undefined || remoteAddress === undefined || remotePort === undefined || localAddress === undefined || localPort === undefined) return false;
		const file = isIPv4(remoteAddress) ? "/proc/net/tcp" : "/proc/net/tcp6";
		const table = await readFile(file, "utf8").catch(() => "");
		const owner = clientOwner(table, { address: remoteAddress, port: remotePort }, { address: localAddress, port: localPort });
		return owner !== undefined && owner !== own;
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
