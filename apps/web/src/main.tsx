import React from "react";
import ReactDOM from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import "./auth-overrides.css";
import "./nodes.css";
import "./integrations.css";
import "./libraries.css";
import "./files.css";
import "./flow-builder.css";
import "./statistics.css";
import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
