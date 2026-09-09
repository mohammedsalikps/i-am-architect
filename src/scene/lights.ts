import * as THREE from "three";

/**
 * Adds basic lighting to the scene: one ambient light for overall
 * visibility, and one directional light to give the test cube and
 * ground plane some shape/shadowing cues.
 */
export function addLights(scene: THREE.Scene): void {
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
  directionalLight.position.set(10, 15, 10);
  scene.add(directionalLight);
}
