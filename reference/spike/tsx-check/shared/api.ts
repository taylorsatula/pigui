export type SessionState = "planning" | "reported";
export interface SessionItem { id: string; title: string; state: SessionState }
