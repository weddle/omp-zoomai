/**
 * Loopback shim: accepts omp's `openai-decisions` request on `POST <shim>/v1/decisions` and forwards it to
 * Zoom AI Services `POST {upstream}/decisions/decide`, splitting >10 questions and mapping the response
 * back. Holds no credential: the key omp resolved arrives as `Authorization: Bearer <key>` and is
 * forwarded once as the configured Zoom auth header. Never logs request bodies or keys.
 */
import {
	fromZoomResponses,
	type OpenAIDecisionsRequest,
	retryAfterSeconds,
	toZoomRequests,
	ZOOM_DECIDE_PATH,
	ZOOM_DEFAULT_BASE_URL,
	ZOOM_MAX_QUESTIONS,
	type ZoomDecideResponse,
} from "./zoom-wire";

export type ZoomAuthMode = "x-api-key" | "bearer";

export interface ShimOptions {
	/** AI Services root; default https://api.zoom.us/v2/aiservices. */
	upstreamBase?: string;
	/** How the key is sent upstream. API ref for decide: `x-api-key`. Auth guide: Bearer also accepted. */
	auth?: ZoomAuthMode;
	maxQuestions?: number;
	/** Chunks in flight at once (Zoom "LIGHT" label; Build accounts use the Pro limit, 30 req/s). */
	chunkParallel?: number;
	fetch?: typeof fetch;
	timeoutMs?: number;
	/** Called once per upstream request with non-sensitive metadata (no bodies, no keys). */
	onUpstream?: (info: { status: number; questions: number; ms: number; requestId?: string }) => void;
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
}

function bearer(req: Request): string | undefined {
	const h = req.headers.get("authorization") ?? "";
	const m = /^Bearer\s+(.+)$/i.exec(h.trim());
	return m ? m[1].trim() : undefined;
}

export function createShimHandler(options: ShimOptions = {}): (req: Request) => Promise<Response> {
	const upstream = (options.upstreamBase ?? ZOOM_DEFAULT_BASE_URL).replace(/\/+$/, "");
	const auth = options.auth ?? "x-api-key";
	const max = options.maxQuestions ?? ZOOM_MAX_QUESTIONS;
	const parallel = Math.max(1, options.chunkParallel ?? 2);
	const doFetch = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? 10_000;

	return async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		if (req.method !== "POST" || !url.pathname.endsWith("/decisions")) {
			return json(404, { error: "zoom-ai shim: only POST */decisions is served" });
		}
		const key = bearer(req);
		// omp substitutes the literal env-var name when the variable is unset; refuse obvious placeholders.
		if (!key || /^[A-Z][A-Z0-9_]*$/.test(key)) {
			return json(401, { error: "zoom-ai shim: no usable credential (set the key env var omp resolves)" });
		}
		let body: OpenAIDecisionsRequest;
		try {
			body = (await req.json()) as OpenAIDecisionsRequest;
		} catch {
			return json(400, { error: "zoom-ai shim: body is not JSON" });
		}
		let chunks;
		try {
			chunks = toZoomRequests(body, { maxQuestions: max });
		} catch (e) {
			return json(400, { error: `zoom-ai shim: ${(e as Error).message}` });
		}
		const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
		if (auth === "x-api-key") headers["x-api-key"] = key;
		else headers.authorization = `Bearer ${key}`;

		const results: ZoomDecideResponse[] = new Array(chunks.length);
		let failure: Response | undefined;
		let next = 0;
		const worker = async () => {
			while (next < chunks.length && !failure) {
				const i = next++;
				const t0 = performance.now();
				let res: Response;
				try {
					res = await doFetch(`${upstream}${ZOOM_DECIDE_PATH}`, {
						method: "POST",
						headers,
						body: JSON.stringify(chunks[i]),
						signal: AbortSignal.timeout(timeoutMs),
					});
				} catch (e) {
					failure ??= json(502, { error: `zoom-ai shim: upstream unreachable: ${(e as Error).name}` });
					return;
				}
				const text = await res.text();
				let parsed: unknown;
				try {
					parsed = text ? JSON.parse(text) : undefined;
				} catch {
					parsed = undefined;
				}
				options.onUpstream?.({
					status: res.status,
					questions: chunks[i].questions.length,
					ms: Math.round(performance.now() - t0),
					requestId: (parsed as { request_id?: string } | undefined)?.request_id,
				});
				if (!res.ok) {
					const extra: Record<string, string> = {};
					const ra = retryAfterSeconds(res.status, res.headers, parsed);
					if (ra !== undefined) extra["retry-after"] = String(Math.ceil(ra));
					// Pass Zoom's error body through (it carries reason/message, never the key).
					failure ??= new Response(text || JSON.stringify({ error: `upstream ${res.status}` }), {
						status: res.status,
						headers: { "content-type": "application/json", ...extra },
					});
					return;
				}
				results[i] = parsed as ZoomDecideResponse;
			}
		};
		await Promise.all(Array.from({ length: Math.min(parallel, chunks.length) }, worker));
		if (failure) return failure;
		try {
			return json(200, fromZoomResponses(results));
		} catch (e) {
			return json(502, { error: `zoom-ai shim: ${(e as Error).message}` });
		}
	};
}

export interface RunningShim {
	url: string;
	stop(): void;
}

/** Serve the shim on 127.0.0.1 at an ephemeral port (loopback only). */
export function startShim(options: ShimOptions = {}, port = 0): RunningShim {
	const handler = createShimHandler(options);
	const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: handler });
	// Never keep omp alive on its own.
	server.unref?.();
	return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
