import { render } from "preact";
import { useState } from "preact/hooks";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { applyImmutable } from "@earendil-works/chord/delta";
import { Row } from "./view.tsx";
import type { SessionItem } from "../shared/api.ts";
function App() {
  const [items] = useState<SessionItem[]>([{ id: "1", title: "Fix login", state: "planning" }]);
  const v = applyImmutable<{ a: number }>({ a: 1 }, [["r", { a: 2 }]]);
  const html = DOMPurify.sanitize(marked.parse("**ok**", { async: false }));
  return <main><ul>{items.map((i) => <Row item={i} />)}</ul><p id="out">{JSON.stringify(v)}</p><div dangerouslySetInnerHTML={{ __html: html }} /></main>;
}
render(<App />, document.getElementById("app")!);
