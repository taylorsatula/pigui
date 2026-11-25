// The idle timer behind the screensaver: it fires after the timeout and re-arms on every reset.
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDLE_MS, idleTimer } from "./idle.ts";

describe("idleTimer", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("is five minutes", () => {
		expect(IDLE_MS).toBe(5 * 60 * 1000);
	});

	it("fires once the timeout passes without a reset", () => {
		vi.useFakeTimers();
		const onIdle = vi.fn();
		idleTimer(onIdle, 1000);
		vi.advanceTimersByTime(999);
		expect(onIdle).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onIdle).toHaveBeenCalledTimes(1);
	});

	it("a reset re-arms the timeout", () => {
		vi.useFakeTimers();
		const onIdle = vi.fn();
		const timer = idleTimer(onIdle, 1000);
		vi.advanceTimersByTime(900);
		timer.reset();
		vi.advanceTimersByTime(900);
		expect(onIdle).not.toHaveBeenCalled();
		vi.advanceTimersByTime(100);
		expect(onIdle).toHaveBeenCalledTimes(1);
	});

	it("cancel stops it firing", () => {
		vi.useFakeTimers();
		const onIdle = vi.fn();
		const timer = idleTimer(onIdle, 1000);
		timer.cancel();
		vi.advanceTimersByTime(5000);
		expect(onIdle).not.toHaveBeenCalled();
	});
});
