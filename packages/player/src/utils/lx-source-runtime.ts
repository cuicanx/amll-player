/**
 * Runs an lx-music-desktop custom source (自定义源) inside the app.
 *
 * The contract is documented at https://lxmusic.toside.cn/desktop/custom-source:
 * the app injects `globalThis.lx`, evaluates the script, waits for the script to
 * emit the `inited` event and then talks to it through the `request` handler.
 * A source never searches on its own - it only turns a `musicInfo` object into a
 * playable URL - so the search side lives in Rust (`online.rs`) while this file
 * is purely about compatibility with existing sources.
 *
 * `lx.request` has to bypass CORS, so every call is proxied through the Rust
 * `online_http` command.
 */
import { invoke } from "@tauri-apps/api/core";

export interface LxSourceInfo {
	name: string;
	description: string;
	version: string;
	author: string;
	homepage: string;
	rawScript: string;
}

export interface LxSourceDecl {
	name?: string;
	type?: string;
	actions?: string[];
	qualitys?: string[];
}

export interface LxInitedPayload {
	status?: boolean;
	sources?: Record<string, LxSourceDecl>;
}

interface OnlineHttpResponse {
	status: number;
	headers: Record<string, string>;
	body: string;
}

const EVENT_INITED = "inited";
const EVENT_REQUEST = "request";
const EVENT_UPDATE_ALERT = "updateAlert";

/** Read the `@name`-style header comment block that every source must carry. */
export function parseScriptInfo(raw: string): LxSourceInfo {
	const head = raw.slice(0, 2000);
	const grab = (key: string) => {
		const match = head.match(new RegExp(`@${key}\\s+([^\\n\\r*]+)`));
		return match ? match[1].trim() : "";
	};
	return {
		name: grab("name") || "未命名音源",
		description: grab("description"),
		version: grab("version"),
		author: grab("author"),
		homepage: grab("homepage"),
		rawScript: raw,
	};
}

//#region tiny helpers a source may call

function md5(input: string | Uint8Array): string {
	// Sources may hash either text or bytes; LX forwards both to crypto.
	const text = typeof input === "string" ? input : bytesToString(input);
	// Compact RFC 1321 implementation - LX sources use it for request signing
	// and we cannot rely on a Node builtin here.
	const toBytes = (str: string) => {
		const bytes: number[] = [];
		for (let i = 0; i < str.length; i++) {
			let code = str.charCodeAt(i);
			if (code < 0x80) bytes.push(code);
			else if (code < 0x800) {
				bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
			} else if (code < 0xd800 || code >= 0xe000) {
				bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
			} else {
				code = 0x10000 + (((code & 0x3ff) << 10) | (str.charCodeAt(++i) & 0x3ff));
				bytes.push(
					0xf0 | (code >> 18),
					0x80 | ((code >> 12) & 0x3f),
					0x80 | ((code >> 6) & 0x3f),
					0x80 | (code & 0x3f),
				);
			}
		}
		return bytes;
	};

	const bytes = toBytes(text);
	const bitLen = bytes.length * 8;
	bytes.push(0x80);
	while (bytes.length % 64 !== 56) bytes.push(0);
	// JS shift counts wrap modulo 32, so `bitLen >>> 32` silently equals
	// `bitLen >>> 0` and used to duplicate the low word. Split the 64-bit
	// length into two 32-bit halves explicitly instead.
	const lowBits = bitLen >>> 0;
	const highBits = Math.floor(bitLen / 0x100000000);
	for (let i = 0; i < 4; i++) bytes.push((lowBits >>> (8 * i)) & 0xff);
	for (let i = 0; i < 4; i++) bytes.push((highBits >>> (8 * i)) & 0xff);

	const s = [
		7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
		14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
		21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
	];
	const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);

	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;

	for (let chunk = 0; chunk < bytes.length; chunk += 64) {
		const m = new Array<number>(16);
		for (let i = 0; i < 16; i++) {
			const o = chunk + i * 4;
			m[i] = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
		}
		let A = a0;
		let B = b0;
		let C = c0;
		let D = d0;
		for (let i = 0; i < 64; i++) {
			let F: number;
			let g: number;
			if (i < 16) {
				F = (B & C) | (~B & D);
				g = i;
			} else if (i < 32) {
				F = (D & B) | (~D & C);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				F = B ^ C ^ D;
				g = (3 * i + 5) % 16;
			} else {
				F = C ^ (B | ~D);
				g = (7 * i) % 16;
			}
			const tmp = D;
			D = C;
			C = B;
			const sum = (A + F + K[i] + m[g]) >>> 0;
			B = (B + ((sum << s[i]) | (sum >>> (32 - s[i])))) >>> 0;
			A = tmp;
		}
		a0 = (a0 + A) >>> 0;
		b0 = (b0 + B) >>> 0;
		c0 = (c0 + C) >>> 0;
		d0 = (d0 + D) >>> 0;
	}

	const hex = (n: number) =>
		Array.from({ length: 4 }, (_, i) => ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, "0")).join("");
	return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

function bytesFrom(data: unknown, encoding?: string): Uint8Array {
	if (typeof data === "string") {
		const enc = (encoding || "utf8").toLowerCase();
		if (enc === "base64") {
			const bin = atob(data);
			return Uint8Array.from(bin, (c) => c.charCodeAt(0));
		}
		if (enc === "hex") {
			const out = new Uint8Array(data.length / 2);
			for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(data.slice(i * 2, i * 2 + 2), 16);
			return out;
		}
		return new TextEncoder().encode(data);
	}
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	return new Uint8Array(0);
}

function bytesToString(data: unknown, encoding?: string): string {
	const bytes = bytesFrom(data);
	const enc = (encoding || "utf8").toLowerCase();
	if (enc === "base64") return btoa(String.fromCharCode(...bytes));
	if (enc === "hex") {
		return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	}
	return new TextDecoder(enc === "utf8" ? "utf-8" : enc).decode(bytes);
}

async function streamThrough(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
	const blob = new Blob([bytes as unknown as BlobPart]);
	const piped = new Blob([blob]).stream().pipeThrough(stream);
	return new Uint8Array(await new Response(piped).arrayBuffer());
}

/**
 * Node's Buffer, as far as a source can tell.
 *
 * LX hands sources a real Buffer and they call `.toString("hex")` on it all the
 * time, so a bare Uint8Array would break signature code.
 */
class LxBuffer extends Uint8Array {
	toString(encoding?: string): string {
		return bytesToString(this, encoding);
	}
}

function bufferFrom(data: unknown, encoding?: string): LxBuffer {
	return new LxBuffer(bytesFrom(data, encoding));
}

/**
 * Temporary instrumentation: log the first few low-level calls a source makes
 * so its behaviour here can be diffed against a reference runtime. Used to find
 * why a source signs requests differently inside the app.
 */
let traceBudget = 14;

function traceUtil(label: string, args: unknown[]): void {
	if (traceBudget <= 0) return;
	traceBudget--;
	const shown = args
		.map((arg) => {
			if (typeof arg === "string") return `${arg.length}:${arg.slice(0, 24)}`;
			if (arg && typeof arg === "object" && "length" in arg) {
				return `bytes[${(arg as { length: number }).length}]`;
			}
			return String(arg);
		})
		.join(" | ");
	void invoke("dev_log", { message: `util ${label} ${shown}` }).catch(() => {});
}


//#endregion

export class LxSourceRuntime {
	readonly info: LxSourceInfo;
	sources: Record<string, LxSourceDecl> = {};

	private handlers = new Map<string, (payload: Record<string, unknown>) => unknown>();
	private inited: LxInitedPayload | null = null;
	private resolveInited: ((payload: LxInitedPayload) => void) | null = null;
	private started = false;
	/** What the source sees as `this` inside its request handler, as in LX. */
	private lxContext: unknown = null;

	constructor(rawScript: string) {
		this.info = parseScriptInfo(rawScript);
	}

	get sourceKeys(): string[] {
		return Object.keys(this.sources);
	}

	async init(timeoutMs = 10_000): Promise<LxInitedPayload> {
		if (!this.started) {
			this.started = true;
			this.evaluate();
		}
		const payload = await new Promise<LxInitedPayload>((resolve, reject) => {
			if (this.inited) return resolve(this.inited);
			this.resolveInited = resolve;
			setTimeout(
				() => reject(new Error("音源初始化超时（脚本未发送 inited 事件）")),
				timeoutMs,
			);
		});
		if (payload.status === false) throw new Error("音源拒绝了初始化");
		this.sources = payload.sources ?? {};
		if (Object.keys(this.sources).length === 0) {
			throw new Error("音源没有声明任何可用平台");
		}
		return payload;
	}

	/** Turn a song into a playable URL through this source. */
	async musicUrl(platform: string, musicInfo: Record<string, unknown>, quality = "128k"): Promise<string> {
		const handler = this.handlers.get(EVENT_REQUEST);
		if (!handler) throw new Error("音源未注册请求处理器");
		if (!this.sources[platform]) throw new Error(`该音源不支持平台 ${platform}`);
		const result = await handler.call(this.lxContext, {
			source: platform,
			action: "musicUrl",
			info: { type: quality, musicInfo },
		});
		const url =
			typeof result === "string"
				? result
				: ((result as { url?: string } | null)?.url ?? "");
		if (!url || !/^https?:\/\//.test(url)) throw new Error("音源没有返回有效的播放地址");
		return url;
	}

	private evaluate() {
		const runtime = this;
		const lx = {
			version: "2.0.0",
			env: "desktop",
			currentScriptInfo: { ...this.info },
			EVENT_NAMES: {
				inited: EVENT_INITED,
				request: EVENT_REQUEST,
				updateAlert: EVENT_UPDATE_ALERT,
			},
			on(event: string, handler: (payload: Record<string, unknown>) => unknown) {
				if (event !== EVENT_REQUEST) {
					return Promise.reject(new Error(`不支持的事件: ${event}`));
				}
				runtime.handlers.set(event, handler);
				return Promise.resolve();
			},
			send(event: string, data: LxInitedPayload) {
				if (event === EVENT_INITED) {
					runtime.inited = data;
					runtime.resolveInited?.(data);
					return Promise.resolve();
				}
				return Promise.resolve();
			},
			request(
				url: string,
				options: {
					method?: string;
					headers?: Record<string, string>;
					body?: string;
					form?: Record<string, string>;
					timeout?: number;
				},
				callback: (err: unknown, resp: Record<string, unknown> | null, body: unknown) => void,
			) {
				let cancelled = false;
				invoke("dev_log", { message: `lx.request ${url}` }).catch(() => {});
				invoke<OnlineHttpResponse>("online_http", {
					req: {
						url,
						method: options?.method ?? "GET",
						headers: options?.headers ?? {},
						body: options?.body,
						form: options?.form,
						timeoutMs: options?.timeout,
					},
				})
					.then((resp) => {
						if (cancelled) return;
						const raw = resp.body;
						// LX parses JSON bodies before handing them over; sources rely
						// on `resp.body.code` style access, so mirror that here.
						let body: unknown = raw;
						try {
							body = JSON.parse(raw);
						} catch {
							body = raw;
						}
						callback(
							null,
							{
								statusCode: resp.status,
								statusMessage: "",
								headers: resp.headers,
								bytes: raw.length,
								raw,
								body,
							},
							body,
						);
					})
					.catch((err) => {
						if (!cancelled) callback(err, null, null);
					});
				return () => {
					cancelled = true;
				};
			},
			utils: {
				buffer: {
					from: (data: unknown, encoding?: string) => {
						traceUtil("buffer.from", [data, encoding]);
						return bufferFrom(data, encoding);
					},
					bufToString: (data: unknown, encoding?: string) => {
						traceUtil("buffer.bufToString", [data, encoding]);
						return bytesToString(data, encoding);
					},
				},
				crypto: {
					md5: (input: string | Uint8Array) => {
						traceUtil("crypto.md5", [input]);
						return md5(input);
					},
					randomBytes: (size: number) => {
						traceUtil("crypto.randomBytes", [size]);
						const bytes = new Uint8Array(size);
						crypto.getRandomValues(bytes);
						return new LxBuffer(bytes);
					},
					aesEncrypt() {
						throw new Error("当前版本不支持 AES 加密的音源");
					},
					rsaEncrypt() {
						throw new Error("当前版本不支持 RSA 加密的音源");
					},
				},
				zlib: {
					inflate: (data: unknown) =>
						streamThrough(bytesFrom(data), new DecompressionStream("deflate")),
					deflate: (data: unknown) =>
						streamThrough(bytesFrom(data), new CompressionStream("deflate")),
				},
			},
		};

		// `globalThis` inside a source must be its own namespace so that two
		// sources cannot clobber each other, but readers that only ask for
		// standard globals (setTimeout, JSON, ...) should still work.
		this.lxContext = lx;
		const own: Record<string, unknown> = { lx };
		const sandbox = new Proxy(own, {
			get(target, key) {
				if (key in target) return target[key as string];
				return (globalThis as unknown as Record<string | symbol, unknown>)[key];
			},
			set(target, key, value) {
				target[key as string] = value;
				return true;
			},
			has(target, key) {
				return key in target || key in globalThis;
			},
		});

		try {
			const fn = new Function("globalThis", "window", "self", "lx", this.info.rawScript);
			fn.call(sandbox, sandbox, sandbox, sandbox, lx);
		} catch (err) {
			throw new Error(`音源脚本执行失败: ${(err as Error)?.message ?? err}`);
		}
	}
}
