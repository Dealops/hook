import { DurableObject } from "cloudflare:workers";

const SESSION_TTL_MS = 60 * 60 * 1000;
const KEEPALIVE_MS = 25_000;

type WebhookEvent = {
	id: string;
	method: string;
	path: string;
	query: Record<string, string>;
	headers: Record<string, string>;
	body: string;
	bodySize: number;
	contentType: string | null;
	receivedAt: number;
	remoteAddr: string | null;
};

type StreamClient = {
	controller: ReadableStreamDefaultController<Uint8Array>;
	keepAlive: ReturnType<typeof setInterval>;
};

export class WebhookSession extends DurableObject<CloudflareEnv> {
	private clients = new Set<StreamClient>();
	private encoder = new TextEncoder();

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/stream") {
			return this.handleStream();
		}
		if (url.pathname.startsWith("/webhook")) {
			return this.handleWebhook(request, url);
		}
		return new Response("Not found", { status: 404 });
	}

	private async getExpiresAt(): Promise<number> {
		return (await this.ctx.storage.get<number>("expiresAt")) ?? 0;
	}

	private async resetExpiry(): Promise<number> {
		const expiresAt = Date.now() + SESSION_TTL_MS;
		await this.ctx.storage.put("expiresAt", expiresAt);
		await this.ctx.storage.setAlarm(expiresAt + 1_000);
		return expiresAt;
	}

	async alarm(): Promise<void> {
		const expiresAt = await this.getExpiresAt();
		if (expiresAt === 0 || Date.now() >= expiresAt) {
			this.broadcast(`event: expired\ndata: {}\n\n`);
			for (const client of this.clients) {
				try {
					client.controller.close();
				} catch {}
				clearInterval(client.keepAlive);
			}
			this.clients.clear();
			await this.ctx.storage.deleteAll();
			return;
		}
		await this.ctx.storage.setAlarm(expiresAt + 1_000);
	}

	private isExpired(expiresAt: number): boolean {
		return expiresAt !== 0 && Date.now() >= expiresAt;
	}

	private broadcast(payload: string): void {
		const encoded = this.encoder.encode(payload);
		for (const client of this.clients) {
			try {
				client.controller.enqueue(encoded);
			} catch {
				clearInterval(client.keepAlive);
				this.clients.delete(client);
			}
		}
	}

	private async handleStream(): Promise<Response> {
		let expiresAt = await this.getExpiresAt();
		if (expiresAt === 0) {
			expiresAt = await this.resetExpiry();
		} else if (this.isExpired(expiresAt)) {
			return new Response("Session expired", { status: 410 });
		}

		const encoder = this.encoder;
		const clients = this.clients;
		const initialEvent = `event: init\ndata: ${JSON.stringify({ expiresAt })}\n\n`;

		let registered: StreamClient | null = null;

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(initialEvent));
				const keepAlive = setInterval(() => {
					try {
						controller.enqueue(encoder.encode(`: keep-alive\n\n`));
					} catch {
						if (registered) {
							clearInterval(registered.keepAlive);
							clients.delete(registered);
						}
					}
				}, KEEPALIVE_MS);
				registered = { controller, keepAlive };
				clients.add(registered);
			},
			cancel() {
				if (registered) {
					clearInterval(registered.keepAlive);
					clients.delete(registered);
				}
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache, no-transform",
				"X-Accel-Buffering": "no",
				Connection: "keep-alive",
			},
		});
	}

	private async handleWebhook(request: Request, url: URL): Promise<Response> {
		if (request.method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: corsHeaders(),
			});
		}

		const existingExpiry = await this.getExpiresAt();
		if (this.isExpired(existingExpiry)) {
			return new Response("Session expired", {
				status: 410,
				headers: corsHeaders(),
			});
		}

		const expiresAt = await this.resetExpiry();

		const subpath = url.pathname.slice("/webhook".length) || "/";
		const query: Record<string, string> = {};
		for (const [k, v] of url.searchParams) query[k] = v;
		const headers: Record<string, string> = {};
		for (const [k, v] of request.headers) headers[k] = v;
		const contentType = request.headers.get("content-type");

		let body = "";
		try {
			body = await request.text();
		} catch {
			body = "";
		}

		const event: WebhookEvent = {
			id: crypto.randomUUID(),
			method: request.method,
			path: subpath,
			query,
			headers,
			body,
			bodySize: body.length,
			contentType,
			receivedAt: Date.now(),
			remoteAddr:
				request.headers.get("cf-connecting-ip") ??
				request.headers.get("x-forwarded-for") ??
				null,
		};

		this.broadcast(
			`event: hook\ndata: ${JSON.stringify({ event, expiresAt })}\n\n`,
		);

		return new Response(
			JSON.stringify({ ok: true, receivedAt: event.receivedAt, expiresAt }),
			{
				status: 200,
				headers: {
					"Content-Type": "application/json",
					...corsHeaders(),
				},
			},
		);
	}
}

function corsHeaders(): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "*",
		"Access-Control-Allow-Headers": "*",
		"Access-Control-Max-Age": "86400",
	};
}
