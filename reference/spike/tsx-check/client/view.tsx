import type { SessionItem } from "../shared/api.ts";
export function Row({ item }: { item: SessionItem }) { return <li data-state={item.state}>{item.title}</li>; }
