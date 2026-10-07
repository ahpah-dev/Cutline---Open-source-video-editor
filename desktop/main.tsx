import { createRoot } from "react-dom/client";
import Editor from "../app/Editor";
import "../app/globals.css";
import "../app/editor/themes.css";
import { applyTheme, savedTheme } from "../app/editor/themes";

document.documentElement.classList.add("desktop-runtime");
applyTheme(savedTheme());

const root = document.getElementById("root");
if (!root) throw new Error("Cutline could not create its desktop window.");

createRoot(root).render(<Editor />);
