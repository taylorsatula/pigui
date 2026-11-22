// A blocking script ahead of the stylesheet, so a chosen theme is in place for the first paint. The stylesheet cannot
// read the choice, and app.js, a module, runs after the page may already have painted in the system's theme.
import { applyTheme, storedTheme } from "./theme.ts";

applyTheme(storedTheme());
