// The Web Push protocol with node:crypto: message encryption (RFC 8291, aes128gcm) and VAPID (RFC 8292).
import { createCipheriv, createECDH, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

export type PushTarget = {
	endpoint: string;
	keys: { p256dh: string; auth: string };
};

export type PushOptions = {
	/** Replaces an undelivered message with the same topic at the push service. */
	topic: string;
	ttlSeconds: number;
};

export interface PushSender {
	/** Resolves with the push service's HTTP status; 404 and 410 mean the subscription is gone. */
	send(target: PushTarget, payload: string, options: PushOptions): Promise<number>;
}

export type VapidKeys = {
	/** Uncompressed P-256 point, base64url: the browser's `applicationServerKey`. */
	publicKey: string;
	/** The private scalar, base64url. */
	privateKey: string;
};

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const fromB64url = (text: string): Buffer => Buffer.from(text, "base64url");

/** Load the server's VAPID keys, creating them on first start. The file is the server's identity to push services. */
export async function loadVapidKeys(file: string): Promise<VapidKeys> {
	if (existsSync(file)) return JSON.parse(await readFile(file, "utf8")) as VapidKeys;
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	const keys = { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
	await writeFile(file, JSON.stringify(keys), { mode: 0o600 });
	return keys;
}

/** The private key as a KeyObject, rebuilt from its raw scalar and public point through a JWK. */
function signingKey(keys: VapidKeys) {
	const point = fromB64url(keys.publicKey);
	return createPrivateKey({
		key: {
			kty: "EC",
			crv: "P-256",
			d: keys.privateKey,
			x: b64url(point.subarray(1, 33)),
			y: b64url(point.subarray(33, 65)),
		},
		format: "jwk",
	});
}

/** The `Authorization` header value for one push service origin (RFC 8292). */
export function vapidAuthorization(keys: VapidKeys, endpoint: string, subject: string, nowSeconds: number): string {
	const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const claims = b64url(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + 12 * 3600, sub: subject })));
	const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key: signingKey(keys), dsaEncoding: "ieee-p1363" });
	return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

export type EncryptionInputs = {
	/** Fixed only by tests of the RFC's example; random otherwise. */
	salt?: Uint8Array;
	/** The sender's ephemeral ECDH private key, likewise. */
	senderPrivateKey?: Uint8Array;
};

/** Encrypt `payload` for one subscription as an aes128gcm body with a single record (RFC 8291 §4). */
export function encryptPayload(target: PushTarget, payload: string, inputs: EncryptionInputs = {}): Buffer {
	const receiverPublic = fromB64url(target.keys.p256dh);
	const authSecret = fromB64url(target.keys.auth);
	const ecdh = createECDH("prime256v1");
	if (inputs.senderPrivateKey === undefined) ecdh.generateKeys();
	else ecdh.setPrivateKey(inputs.senderPrivateKey);
	const senderPublic = ecdh.getPublicKey();
	const shared = ecdh.computeSecret(receiverPublic);
	const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), receiverPublic, senderPublic]);
	const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
	const salt = inputs.salt === undefined ? randomBytes(16) : Buffer.from(inputs.salt);
	const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
	const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
	const cipher = createCipheriv("aes-128-gcm", cek, nonce);
	// 0x02 marks the last (here the only) record.
	const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
	const recordSize = Buffer.alloc(4);
	recordSize.writeUInt32BE(4096);
	return Buffer.concat([salt, recordSize, Buffer.from([senderPublic.length]), senderPublic, body]);
}

/** Sends to real push services (Apple, Google, Mozilla) over HTTPS. */
export class WebPushSender implements PushSender {
	readonly #keys: VapidKeys;
	readonly #subject: string;

	constructor(keys: VapidKeys, subject: string) {
		this.#keys = keys;
		this.#subject = subject;
	}

	async send(target: PushTarget, payload: string, options: PushOptions): Promise<number> {
		const response = await fetch(target.endpoint, {
			method: "POST",
			headers: {
				Authorization: vapidAuthorization(this.#keys, target.endpoint, this.#subject, Math.floor(Date.now() / 1000)),
				"Content-Encoding": "aes128gcm",
				"Content-Type": "application/octet-stream",
				TTL: String(options.ttlSeconds),
				Topic: options.topic,
				Urgency: "high",
			},
			body: encryptPayload(target, payload),
			signal: AbortSignal.timeout(30_000),
		});
		await response.body?.cancel();
		return response.status;
	}
}

/** Keeps what would have been sent, for fake mode and tests: no push service is reachable without credentials. */
export class RecordingPushSender implements PushSender {
	readonly sent: { target: PushTarget; payload: string; options: PushOptions }[] = [];

	async send(target: PushTarget, payload: string, options: PushOptions): Promise<number> {
		this.sent.push({ target, payload, options });
		return 201;
	}
}

/** Check a subscription's keys before storing it, so a malformed one fails at the HTTP boundary, not at send time. */
export function validPushKeys(keys: { p256dh: string; auth: string }): boolean {
	try {
		createPublicKey({ key: { kty: "EC", crv: "P-256", ...pointToJwk(fromB64url(keys.p256dh)) }, format: "jwk" });
		return fromB64url(keys.auth).length === 16;
	} catch {
		return false;
	}
}

function pointToJwk(point: Buffer): { x: string; y: string } {
	if (point.length !== 65 || point[0] !== 4) throw new Error("not an uncompressed P-256 point");
	return { x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33, 65)) };
}
