import * as THREE from "three";

/**
 * A single placeholder cube used only to verify the render pipeline
 * (geometry, materials, lighting, camera) works end to end.
 * Not part of the construction engine - that comes later.
 */
export function addTestCube(scene: THREE.Scene): void {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color: 0x4f8ef7 });
  const cube = new THREE.Mesh(geometry, material);
  cube.position.set(0, 0.5, 0); // sit on top of the ground plane
  scene.add(cube);
}
