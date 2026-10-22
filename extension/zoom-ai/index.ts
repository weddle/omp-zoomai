/**
 * omp extension: Zoom AI Services Decisions as `judge`-role models.
 *
 * Install project-locally: copy or symlink this directory to `<project>/.omp/extensions/zoom-ai/`
 * (omp's native project extension root; see docs/omp-extension-point.md). Select it with
 * `modelRoles: { judge: zoom-ai/zoom-decisions }` in `<project>/.omp/config.yml`.
 *
 * Fail-closed: registers nothing unless BOTH `ZOOM_AI_ENABLE=1` and the key variable are set.
 *   ZOOM_AI_ENABLE=1             explicit opt-in (no accidental paid calls if a key exists in env)
 *   ZOOM_AI_KEY_ENV=NAME         env var holding the key (default ZOOM_AI_API_KEY)
 *   ZOOM_AI_BASE_URL=URL         AI Services root (default https://api.zoom.us/v2/aiservices; tests point at the mock)
 *   ZOOM_AI_AUTH=x-api-key|bearer  upstream auth header (default x-api-key, per the decide API reference)
 *   ZOOM_AI_IMAGES=1             advertise image input (off: Zoom's image limits are undocumented)
 */
import { type RunningShim, startShim, type ZoomAuthMode } from "./shim";

export const PROVIDER_ID = "zoom-ai";

/** Public list prices, https://www.zoom.com/en/products/ai-services/decisions-api/ (USD per 1M input tokens). */
export const PRICES = { "zoom-decisions": 0.042, "zoom-decisions-pro": 0.1 } as const;

/** Minimal slice of omp's ExtensionAPI used here (avoids a build-time dependency on omp packages). */
export interface MinimalExtensionAPI {
	registerProvider(name: string, config: Record<string, unknown>): void;
	on?(event: string, handler: (...args: unknown[]) => unknown): void;
}

export function providerConfig(shimUrl: string, keyEnv: string, images: boolean): Record<string, unknown> {
	const model = (id: keyof typeof PRICES, name: string) => ({
		id,
		name,
		api: "openai-decisions",
		reasoning: false,
		input: images ? ["text", "image"] : ["text"],
		cost: { input: PRICES[id], output: 0, cacheRead: 0, cacheWrite: 0 },
		// Not published by Zoom (INFER placeholders); judgments do not use these budgets for prompting.
		contextWindow: 64_000,
		maxTokens: 1,
	});
	return {
		// omp's openai-decisions wire posts to `${baseUrl}/decisions`.
		baseUrl: `${shimUrl}/v1`,
		apiKey: keyEnv,
		api: "openai-decisions",
		models: [model("zoom-decisions", "Zoom Decisions"), model("zoom-decisions-pro", "Zoom Decisions Pro")],
	};
}

let running: RunningShim | undefined;

export default function zoomAi(pi: MinimalExtensionAPI, env: Record<string, string | undefined> = process.env): void {
	if (env.ZOOM_AI_ENABLE !== "1") return;
	const keyEnv = env.ZOOM_AI_KEY_ENV?.trim() || "ZOOM_AI_API_KEY";
	if (!env[keyEnv]) return;
	const auth: ZoomAuthMode = env.ZOOM_AI_AUTH === "bearer" ? "bearer" : "x-api-key";
	running ??= startShim({ upstreamBase: env.ZOOM_AI_BASE_URL, auth });
	pi.registerProvider(PROVIDER_ID, providerConfig(running.url, keyEnv, env.ZOOM_AI_IMAGES === "1"));
	pi.on?.("session_shutdown", () => {
		running?.stop();
		running = undefined;
	});
}

/** Test hook. */
export function _stopShim(): void {
	running?.stop();
	running = undefined;
}
