// Real mode's models: Pi's own configuration, read through Pi's own classes. picloud adds no provider code.
import { join } from "node:path";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelRef } from "@earendil-works/pi-durable";

const SIGN_IN_MESSAGE = `Pi has no default model with credentials, so picloud cannot run it.

Sign in with Pi as the user picloud runs as: run pi, type /login, then /model.
  With Docker:        docker compose run --rm picloud pi
                      then: docker compose restart picloud
  With the installer: sudo -u picloud -i pi
                      then: sudo systemctl restart picloud
  With OnPrem:        pi, as yourself
                      then run the OnPrem one-liner again (README, "PiCloud OnPrem")`;

export class NotSignedIn extends Error {}

export type PiModels = {
	runtime: ModelRuntime;
	/** Pi's current default model, re-read for each new session so a later /model choice applies. */
	defaultModel(): ModelRef;
};

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
