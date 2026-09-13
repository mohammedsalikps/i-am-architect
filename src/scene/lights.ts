import * as THREE from "three";

/**
 * Architectural viewport lighting. A THREE.HemisphereLight stands in for
 * bounced sky/ground light - the cheap, texture-free alternative to a
 * full HDRI environment map - so a MeshStandardMaterial's shadowed side
 * never reads as flat black. One shadow-casting directional "sun" light
 * gives every object a real, readable shadow on the ground and on other
 * objects: the single biggest lift from "primitive Three.js demo" to
 * "high-quality interactive visualization" (see SceneManager.ts for the
 * renderer's shadowMap/tone-mapping setup this assumes). A low-intensity
 * fill light from the opposite side keeps the shadowed face of a
 * building from going pure black, without a second shadow map (it never
 * casts one). Intensities are tuned for THREE.ACESFilmicToneMapping.
 */
export function addLights(scene: THREE.Scene): void {
  const hemisphere = new THREE.HemisphereLight(0xcfe0ff, 0x2b2620, 0.65);
  scene.add(hemisphere);

  const sun = new THREE.DirectionalLight(0xfff3e0, 2.6);
  sun.position.set(12, 18, 9);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  // Sized to comfortably cover a typical single-building project (see
  // Fit House/fitToScene()'s own framing) without an unnecessarily huge
  // (and therefore blurry-per-texel) shadow frustum.
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -22;
  sun.shadow.camera.right = 22;
  sun.shadow.camera.top = 22;
  sun.shadow.camera.bottom = -22;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 60;
  sun.shadow.bias = -0.0015;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target);

  const fill = new THREE.DirectionalLight(0xdce8ff, 0.35);
  fill.position.set(-10, 6, -8);
  scene.add(fill);
}
