import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";
const root = document.documentElement;
root.dataset.keyboardFocus = "";
window.addEventListener("pointerdown", () => { delete root.dataset.keyboardFocus; }, true);
window.addEventListener("keydown", event => {
  if (event.key === "Tab") root.dataset.keyboardFocus = "";
}, true);

createApp(App).mount("#app");
