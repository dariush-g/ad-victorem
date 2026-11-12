import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

export const BASE_CHROMA = 0; // no resting colour fringe: edges stay clean; hits still pulse it

/**
 * Whole post chain in one full-screen pass: radial RGB split (zero at screen centre),
 * vignette, filmic tone curve, fine film grain, and conversion to the display colour space.
 */
export function createPost(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const material = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: target.texture },
      amount: { value: BASE_CHROMA },
      vignette: { value: 0.3 },
      saturation: { value: 1.12 },
      grain: { value: 0 },
      time: { value: 0 },
    },
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform float amount;
      uniform float vignette;
      uniform float saturation;
      uniform float grain;
      uniform float time;
      varying vec2 vUv;
      void main() {
        vec2 d = vUv - 0.5;
        vec2 off = d * length(d) * amount * 2.0;
        vec3 c = vec3(
          texture2D(tDiffuse, vUv + off).r,
          texture2D(tDiffuse, vUv).g,
          texture2D(tDiffuse, vUv - off).b);
        c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14); // filmic curve: soft highlights, deeper shade
        c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, saturation);
        c *= 1.0 - vignette * smoothstep(0.25, 0.85, length(d));
        // luminance grain, strongest in the midtones, re-seeded every frame
        float n = fract(sin(dot(gl_FragCoord.xy + time * 61.7, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
        c += n * grain * (1.0 - abs(dot(c, vec3(0.333)) * 2.0 - 1.0) * 0.6);
        gl_FragColor = vec4(max(c, 0.0), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const quad = new FullScreenQuad(material);

  return {
    render() {
      material.uniforms.time.value = (material.uniforms.time.value + 1) % 1000;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      quad.render(renderer);
    },
    resize(w: number, h: number) {
      const pr = renderer.getPixelRatio();
      target.setSize(Math.max(1, Math.round(w * pr)), Math.max(1, Math.round(h * pr)));
    },
    setChroma(v: number) {
      material.uniforms.amount.value = v;
    },
  };
}
