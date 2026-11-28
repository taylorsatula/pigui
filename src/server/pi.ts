// Real mode's models: Pi's own configuration, read through Pi's own classes. pigui adds no provider code.
import { join } from "node:path";
import { DefaultResourceLoader, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelRef } from "@earendil-works/pi-durable";

const SIGN_IN_MESSAGE = `Pi has no default model with credentials, so pigui cannot run it.

Sign in with Pi as the user pigui runs as: run pi, type /login, then /model.
  With Docker:        docker compose run --rm pigui pi
                      then: docker compose restart pigui
  With the installer: sudo -u pigui -i pi
                      then: sudo systemctl restart pigui
  With OnPrem:        pi, as yourself
                      then run the OnPrem one-liner again (README, "PiGUI OnPrem")`;

export class NotSignedIn extends Error {}

export type PiModels = {
	runtime: ModelRuntime;
	/** Pi's current default model, re-read for each new session so a later /model choice applies. */
	defaultModel(): ModelRef;
};

/**
 * Pi's extensions register providers (lunaroute, and any other extension-provided provider) that a bare ModelRuntime
 * does not know. Pi loads them from the user's settings packages and global extensions directory, then flushes the
 * registrations into the runtime; pigui does the same, so an extension-only provider is visible here exactly as it is
 * in Pi. Project-local extensions are not loaded: pigui is a service, and its startup must not execute code from
 * whatever directory it was started in.
 */
async function registerExtensionProviders(runtime: ModelRuntime, agentDir: string): Promise<void> {
	const cwd = process.cwd();
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	await loader.reload();
	const loaded = loader.getExtensions();
	for (const { path, error } of loaded.errors) {
		process.stderr.write(`pigui: extension ${path} failed to load: ${error}\n`);
	}
	const pending = loaded.runtime;
	for (const { name, config, extensionPath } of pending.pendingProviderRegistrations) {
		try {
			runtime.registerProvider(name, config);
		} catch (error) {
			process.stderr.write(`pigui: extension ${extensionPath} could not register provider ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
		}
	}
	pending.pendingProviderRegistrations = [];
	for (const { provider, extensionPath } of pending.pendingNativeProviderRegistrations) {
		try {
			runtime.registerNativeProvider(provider);
		} catch (error) {
			process.stderr.write(`pigui: extension ${extensionPath} could not register provider ${provider.id}: ${error instanceof Error ? error.message : String(error)}\n`);
		}
	}
	pending.pendingNativeProviderRegistrations = [];
	for (const { definition, extensionPath } of pending.pendingVirtualModelRegistrations) {
		try {
			runtime.registerVirtualModel(definition);
		} catch (error) {
			process.stderr.write(`pigui: extension ${extensionPath} could not register a virtual model: ${error instanceof Error ? error.message : String(error)}\n`);
		}
	}
	pending.pendingVirtualModelRegistrations = [];
	await runtime.refresh({ allowNetwork: false });
}

/**
 * Pi's configured models and its default model, or `NotSignedIn` when there is no default model with credentials.
 * Reads only Pi's configuration directory, so it can run before anything else is touched.
 */
export async function loadPiModels(agentDir: string): Promise<PiModels> {
	const settings = (): ModelRef | undefined => {
		const manager = SettingsManager.create(agentDir, agentDir);
		const provider = manager.getDefaultProvider();
		const modelId = manager.getDefaultModel();
		return provider === undefined || modelId === undefined ? undefined : { provider, modelId };
	};
	const initial = settings();
	if (initial === undefined) throw new NotSignedIn(SIGN_IN_MESSAGE);
	const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
	await registerExtensionProviders(runtime, agentDir);
	if (runtime.getModel(initial.provider, initial.modelId) === undefined || !runtime.hasConfiguredAuth(initial.provider)) {
		throw new NotSignedIn(SIGN_IN_MESSAGE);
	}
	return {
		runtime,
		defaultModel: () => {
			const current = settings();
			return current !== undefined && runtime.getModel(current.provider, current.modelId) !== undefined ? current : initial;
		},
	};
}
