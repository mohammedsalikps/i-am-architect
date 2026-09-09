import { SceneManager } from "./scene/SceneManager";

const container = document.getElementById("app");

if (!container) {
  throw new Error("Missing #app element in index.html");
}

const sceneManager = new SceneManager(container);
sceneManager.start();
