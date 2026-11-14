import { render } from "preact";
import { App } from "./App";
import { LangProvider } from "./i18n";
import "./styles/fonts.css";
import "./styles/moony.css";
import "./styles/app.css";

render(
  <LangProvider>
    <App />
  </LangProvider>,
  document.getElementById("root")!,
);
