// How a local model (Kokoro for speech, LEAF for memory) is held in memory, as PICLOUD_MODELS_UNLOAD says: loaded as
// the server starts and kept, so the first use waits on no load; or loaded on first use and released once it has sat
// idle that long, giving its memory back on a machine with little to spare at the cost of a load on the next use.
import { errorKind, type Logger } from "./log.ts";

export type HeldModel<T> = {
	/** Run `work` with the model, loading it first if it is not loaded; it is not released while any work runs. */
	use<R>(work: (model: T) => Promise<R>): Promise<R>;
};

export function heldModel<T>(options: {
	/** The log events' prefix: `speech` or `memory`. */
	name: string;
	load: () => Promise<T>;
	release: (model: T) => Promise<unknown>;
	/** Undefined: load now and keep. Otherwise how long after its last use the model is released. */
	unloadAfterMs: number | undefined;
	log: Logger;
}): HeldModel<T> {
	const { name, log, unloadAfterMs } = options;
	let model: Promise<T> | undefined;
	let busy = 0;
	let idle: NodeJS.Timeout | undefined;
	// A load that fails is logged, and the next use tries again.
	const loaded = () => {
		if (model === undefined) {
			const started = Date.now();
			const loading = options.load();
			model = loading;
			loading.then(
				() => log.info(`${name}.ready`, { ms: Date.now() - started }),
				(error: unknown) => {
					if (model === loading) model = undefined;
					log.error(`${name}.load`, { error: errorKind(error) });
				},
			);
		}
		return model;
	};
	const release = () => {
		const held = model;
		model = undefined;
		held
			?.then((it) => options.release(it))
			.then(
				() => log.info(`${name}.released`, { idleMs: unloadAfterMs }),
				(error: unknown) => log.error(`${name}.release`, { error: errorKind(error) }),
			);
	};
	if (unloadAfterMs === undefined) void loaded().catch(() => undefined);
	return {
		async use(work) {
			busy++;
			clearTimeout(idle);
			try {
				return await work(await loaded());
			} finally {
				if (--busy === 0 && unloadAfterMs !== undefined) idle = setTimeout(release, unloadAfterMs).unref();
			}
		},
	};
}
