import { render } from "preact";
import { App } from "./App.tsx";
import { readEmbeddedConfig } from "./lucky.ts";

const config = readEmbeddedConfig();
const root = document.getElementById("app");
if (root) {
  render(<App config={config} />, root);
}
