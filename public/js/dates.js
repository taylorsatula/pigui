// Formats server-rendered timestamps in the browser's local timezone via native Intl.DateTimeFormat.

const DAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const SHORT_DATE_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const FULL_DATE_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function sameLocalDay(a, b) {
	return new Date(a).toDateString() === new Date(b).toDateString();
}

function formatListingDate(at, now = Date.now()) {
	const date = new Date(at);
	const time = TIME_FMT.format(date);
	if (sameLocalDay(at, now)) return `Today at ${time}`;
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	if (sameLocalDay(at, yesterday.getTime())) return `Yesterday at ${time}`;
	if (date.getFullYear() !== new Date(now).getFullYear()) return FULL_DATE_FMT.format(date);
	return `${SHORT_DATE_FMT.format(date)} at ${time}`;
}

export function localizeDates(root = document) {
	const now = Date.now();
	for (const el of root.querySelectorAll("h2.day[data-at]")) {
		const at = Number(el.dataset.at);
		if (Number.isFinite(at)) el.textContent = DAY_FMT.format(new Date(at));
	}
	for (const el of root.querySelectorAll("time.row-modified[data-at]")) {
		const at = Number(el.dataset.at);
		const wide = el.querySelector(".when-wide");
		if (Number.isFinite(at) && wide) wide.textContent = formatListingDate(at, now);
	}
}
