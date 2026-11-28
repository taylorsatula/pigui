// Pointer swipe-down gesture for sheets and toasts, using iOS deceleration projection.

const SLOP = 6;
const SPEED_WINDOW = 100;

export function exitMs() {
	return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--quick")) || 200;
}

function project(position, speed) {
	return position + (speed * 0.998) / (1 - 0.998);
}

export function attachSwipeDown(node, options) {
	let active = null;

	const reset = () => {
		node.classList.remove("dragging");
		node.style.transform = "";
		options.onHold?.(false);
		active = null;
	};

	const onDown = (event) => {
		if (event.button !== 0 || !options.canStart(event.target)) return;
		active = { id: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false, samples: [{ y: event.clientY, t: performance.now() }] };
		options.onHold?.(true);
	};

	const onMove = (event) => {
		if (active === null || event.pointerId !== active.id) return;
		const dx = event.clientX - active.startX;
		const dy = event.clientY - active.startY;
		if (!active.dragging) {
			if (Math.hypot(dx, dy) < SLOP) return;
			if (dy <= 0 || Math.abs(dy) < Math.abs(dx)) {
				options.onHold?.(false);
				active = null;
				return;
			}
			active.dragging = true;
			node.classList.add("dragging");
			try {
				node.setPointerCapture(event.pointerId);
			} catch {
				// Pointer capture is optional.
			}
		}
		const now = performance.now();
		active.samples.push({ y: event.clientY, t: now });
		while (active.samples.length > 2 && now - active.samples[0].t > SPEED_WINDOW) active.samples.shift();
		const offset = dy >= 0 ? dy : dy * 0.25;
		node.style.transform = `translateY(${offset}px)`;
	};

	const onEnd = (event) => {
		if (active === null || event.pointerId !== active.id) return;
		const wasDragging = active.dragging;
		const dy = Math.max(0, event.clientY - active.startY);
		let speed = 0;
		if (active.samples.length >= 2) {
			const first = active.samples[0];
			const last = active.samples[active.samples.length - 1];
			const dt = last.t - first.t;
			if (dt > 0) speed = (last.y - first.y) / dt;
		}
		const threshold = options.distance(node.offsetHeight || 200);
		reset();
		if (wasDragging && project(dy, Math.max(0, speed)) > threshold) options.onDismiss();
	};

	node.addEventListener("pointerdown", onDown);
	node.addEventListener("pointermove", onMove);
	node.addEventListener("pointerup", onEnd);
	node.addEventListener("pointercancel", onEnd);

	return () => {
		node.removeEventListener("pointerdown", onDown);
		node.removeEventListener("pointermove", onMove);
		node.removeEventListener("pointerup", onEnd);
		node.removeEventListener("pointercancel", onEnd);
	};
}
