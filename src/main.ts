import fixture from "../fixtures/synthetic-trace.json";
import { mountApp } from "./app";
import { validateTrace } from "./validate";
import "./styles.css";

const root = document.getElementById("app");
if (!root) throw new Error("#app missing");
const result = validateTrace(fixture);
mountApp(root, result.ok ? result.trace : null, result.ok ? [] : result.issues);
