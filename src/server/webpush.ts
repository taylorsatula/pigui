// Web Push built straight on node:crypto. A subscription's payload is encrypted with aes128gcm as RFC 8291
// lays out, and each request carries a short-lived VAPID token (RFC 8292) so the push service knows which
// application server is calling.
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

const encodeBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const decodeBase64Url = (text: string): Buffer => Buffer.from(text, "base64url");

/** Base64url-encoded JSON, the encoding JWS pieces come in. */
function jsonBase64Url(value: unknown): string {
	return encodeBase64Url(Buffer.from(JSON.stringify(value), "utf8"));
}

/**
 * Read the server's VAPID keys, minting and persisting them on first start. This file is the identity the
 * server shows push services; without it every start would look like a new application server.
 */
export async function loadVapidKeys(file: string): Promise<VapidKeys> {
	if (existsSync(file)) return JSON.parse(await readFile(file, "utf8")) as VapidKeys;
	const generated = createECDH("prime256v1");
	generated.generateKeys();
	const minted: VapidKeys = { publicKey: encodeBase64Url(generated.getPublicKey()), privateKey: encodeBase64Url(generated.getPrivateKey()) };
	await writeFile(file, JSON.stringify(minted), { mode: 0o600 });
	return minted;
}

/** A JWK holding the pair, the interchange format `createPrivateKey` accepts for an EC private scalar. */
function signingJwk(keys: VapidKeys): Record<string, string> {
	const point = decodeBase64Url(keys.publicKey);
	return {
		kty: "EC",
		crv: "P-256",
		d: keys.privateKey,
		x: encodeBase64Url(point.subarray(1, 33)),
		y: encodeBase64Url(point.subarray(33, 65)),
	};
}

/** The `Authorization` header for one push service origin, proving the sender (RFC 8292). */
function vapidAuthorization(keys: VapidKeys, endpoint: string, subject: string, nowSeconds: number): string {
	const signingInput = `${jsonBase64Url({ typ: "JWT", alg: "ES256" })}.${jsonBase64Url({ aud: new URL(endpoint).origin, exp: nowSeconds + 12 * 3600, sub: subject })}`;
	const key = createPrivateKey({ key: signingJwk(keys), format: "jwk" });
	const signature = sign("sha256", Buffer.from(signingInput, "utf8"), { key, dsaEncoding: "ieee-p1363" });
	return `vapid t=${signingInput}.${encodeBase64Url(signature)}, k=${keys.publicKey}`;
}

export type EncryptionInputs = {
	/** Fixed only by tests of the RFC's example; random otherwise. */
	salt?: Uint8Array;
	/** The sender's ephemeral ECDH private key, likewise. */
	senderPrivateKey?: Uint8Array;
};

/** The content-encryption key and nonce RFC 8291 derives from the ECDH agreement and the auth secret. */
function contentKeys(input: { shared: Buffer; authSecret: Buffer; receiverPublic: Buffer; senderPublic: Buffer; salt: Buffer }): { key: Buffer; nonce: Buffer } {
	const info = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), input.receiverPublic, input.senderPublic]);
	const ikm = Buffer.from(hkdfSync("sha256", input.shared, input.authSecret, info, 32));
	return {
		key: Buffer.from(hkdfSync("sha256", ikm, input.salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16)),
		nonce: Buffer.from(hkdfSync("sha256", ikm, input.salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12)),
	};
}

/** The aes128gcm record payload: the message, one 0x02 delimiter for the (only) final record, then the tag. */
function encryptRecord(key: Buffer, nonce: Buffer, payload: string): Buffer {
	const cipher = createCipheriv("aes-128-gcm", key, nonce);
	const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from([0x02])])), cipher.final()]);
	return Buffer.concat([sealed, cipher.getAuthTag()]);
}

/** Encrypt `payload` for one subscription as an aes128gcm body with a single record (RFC 8291 §4). */
export function encryptPayload(target: PushTarget, payload: string, inputs: EncryptionInputs = {}): Buffer {
	const receiverPublic = decodeBase64Url(target.keys.p256dh);
	const authSecret = decodeBase64Url(target.keys.auth);
	const ecdh = createECDH("prime256v1");
	if (inputs.senderPrivateKey === undefined) ecdh.generateKeys();
	else ecdh.setPrivateKey(inputs.senderPrivateKey);
	const senderPublic = ecdh.getPublicKey();
	const shared = ecdh.computeSecret(receiverPublic);
	const salt = inputs.salt === undefined ? randomBytes(16) : Buffer.from(inputs.salt);
	const { key, nonce } = contentKeys({ shared, authSecret, receiverPublic, senderPublic, salt });
	const record = encryptRecord(key, nonce, payload);
	const recordSize = Buffer.alloc(4);
	recordSize.writeUInt32BE(4096);
	return Buffer.concat([salt, recordSize, Buffer.from([senderPublic.length]), senderPublic, record]);
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
		const headers = {
			Authorization: vapidAuthorization(this.#keys, target.endpoint, this.#subject, Math.floor(Date.now() / 1000)),
			"Content-Encoding": "aes128gcm",
			"Content-Type": "application/octet-stream",
			TTL: String(options.ttlSeconds),
			Topic: options.topic,
			Urgency: "high",
		};
		const response = await fetch(target.endpoint, { method: "POST", headers, body: encryptPayload(target, payload), signal: AbortSignal.timeout(30_000) });
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
		createPublicKey({ key: { kty: "EC", crv: "P-256", ...pointCoordinates(decodeBase64Url(keys.p256dh)) }, format: "jwk" });
		return decodeBase64Url(keys.auth).length === 16;
	} catch {
		return false;
	}
}

/** The uncompressed P-256 point as JWK x/y coordinates; throws when the point is not one. */
function pointCoordinates(point: Buffer): { x: string; y: string } {
	if (point.length !== 65 || point[0] !== 4) throw new Error("not an uncompressed P-256 point");
	return { x: encodeBase64Url(point.subarray(1, 33)), y: encodeBase64Url(point.subarray(33, 65)) };
}
