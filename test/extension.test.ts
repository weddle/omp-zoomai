import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import zoomAi, { _stopShim, PROVIDER_ID, providerConfig } from "../extension/zoom-ai/index";

const VENDOR = `${import.meta.dir}/../vendor/oh-my-pi/packages/coding-agent/src/config/models-config.ts`;

function fakePi() {
	const calls: { name: string; config: any }[] = [];
	return { calls, pi: { registerProvider: (name: string, config: any) => calls.push({ name, config }), on: () => {} } };
}
afterEach(() => _stopShim());

test("fail-closed: nothing registered without ZOOM_AI_ENABLE=1 and a key", () => {
	for (const env of [{}, { ZOOM_AI_API_KEY: "k" }, { ZOOM_AI_ENABLE: "1" }, { ZOOM_AI_ENABLE: "true", ZOOM_AI_API_KEY: "k" }]) {
		const { calls, pi } = fakePi();
		zoomAi(pi, env);
		expect(calls.length).toBe(0);
	}
});

test("registers zoom-ai judge models on the openai-decisions api behind a loopback shim", () => {
	const { calls, pi } = fakePi();
	zoomAi(pi, { ZOOM_AI_ENABLE: "1", ZOOM_AI_API_KEY: "k", ZOOM_AI_BASE_URL: "http://127.0.0.1:9/v2/aiservices" });
	expect(calls.length).toBe(1);
	const { name, config } = calls[0];
	expect(name).toBe(PROVIDER_ID);
	expect(config.api).toBe("openai-decisions");
	expect(config.apiKey).toBe("ZOOM_AI_API_KEY"); // env-var NAME, never the value
	expect(config.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
	expect(config.models.map((m: any) => m.id)).toEqual(["zoom-decisions", "zoom-decisions-pro"]);
	expect(config.models.map((m: any) => m.cost.input)).toEqual([0.042, 0.1]);
	expect(config.models.every((m: any) => m.input.length === 1)).toBe(true); // text-only unless ZOOM_AI_IMAGES=1
	expect(JSON.stringify(config)).not.toContain('"k"');
});

test("custom key variable name is honored", () => {
	const { calls, pi } = fakePi();
	zoomAi(pi, { ZOOM_AI_ENABLE: "1", ZOOM_AI_KEY_ENV: "MY_ZOOM", MY_ZOOM: "x" });
	expect(calls[0].config.apiKey).toBe("MY_ZOOM");
});

test.skipIf(!existsSync(VENDOR))("omp v18.12.1 accepts the config (validateProviderConfiguration, runtime-register)", async () => {
	const { validateProviderConfiguration } = await import(VENDOR);
	const c = providerConfig("http://127.0.0.1:1", "ZOOM_AI_API_KEY", false) as any;
	expect(() =>
		validateProviderConfiguration(PROVIDER_ID, { baseUrl: c.baseUrl, apiKey: c.apiKey, api: c.api, models: c.models }, "runtime-register"),
	).not.toThrow();
});
