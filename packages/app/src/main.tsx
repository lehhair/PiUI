import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme } from "./theme/bootstrap";
import { App } from "./App";
import "./index.css";

applyTheme("eucalyptus", "system");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
