import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

export const BASE_CHROMA = 0; // no resting colour fringe: edges stay clean; hits still pulse it

/** Height in pixels of the low-resolution image the game renders at. */
export const PIXEL_HEIGHT = 540;

/**
 * The fixed palette every pixel is snapped to (sRGB): tuned to the arena at dusk. Violet shade,
 * sand and stone ramps, timber browns, burnt orange, crimson, bronze and gold, iron and steel, skin.
 */
const PALETTE_HEX = [
  0x0c0a0e, 0x1a1218, 0x2e1d24, 0x4a2c2e, 0x3a3352, 0x5b4f7a, 0x8f88d2,
  0x6b3f26, 0x8e5631, 0xa9683a, 0xc4864a,
  0x5a3018, 0x8a4a1e, 0xb0602a, 0xd07a34, // burnt orange: the shaded stands and ceilings at sunset
  0x9c7a52, 0xb08a5c, 0xdcab6c, 0xe0c392, 0xf0d19a, 0xf6e6c4, 0xfff6e0,
  0x5e1c1e, 0x9a2e2a, 0xc0342e,
  0xc08a3e, 0xecb23a, 0xff9244, 0xffb648,
  0x4c4856, 0x7a7886, 0xc4c7cf,
  0x8a5640, 0xb57b5a, 0xd9a07c,
];

/**
 * The game's look, in one full-screen pass. The scene is rendered small (PIXEL_HEIGHT tall, no MSAA)
 * and shown with nearest sampling, so polygon edges become a pixel grid. On that grid: radial RGB split
 * (zero at screen centre, pulsed by hits), filmic tone curve, vignette, then edges drawn as light and
 * shadow (the far side of a silhouette darkens, the top edge of a nearer surface catches a highlight),
 * and every pixel snapped to the nearest colour of a fixed palette with ordered dithering between them.
 */
export function createPost(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthTexture: new THREE.DepthTexture(1, 1),
  });

  const material = new THREE.ShaderMaterial({
    defines: { PAL_N: PALETTE_HEX.length },
    uniforms: {
      tDiffuse: { value: target.texture },
      tDepth: { value: target.depthTexture },
      res: { value: new THREE.Vector2(1, 1) },
      near: { value: camera.near },
      far: { value: camera.far },
      amount: { value: BASE_CHROMA },
      vignette: { value: 0.3 },
      saturation: { value: 1.12 },
      // palette colours kept as written (gamma space): matching happens there
      pal: { value: PALETTE_HEX.map((h) => new THREE.Color().setHex(h, THREE.LinearSRGBColorSpace)) },
      palDither: { value: 0.09 }, // how far the ordered dither nudges a colour before matching
      shade: { value: 0.55 }, // brightness kept at the far side of a silhouette
      rim: { value: 0.22 }, // highlight added along a near surface's top edge
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
      uniform sampler2D tDepth;
      uniform vec2 res;
      uniform float near, far;
      uniform float amount;
      uniform float vignette;
      uniform float saturation;
      uniform vec3 pal[PAL_N];
      uniform float palDither, shade, rim;
      varying vec2 vUv;

      float linDepth(vec2 uv) {
        float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
        return 2.0 * near * far / (far + near - z * (far - near));
      }
      // 4x4 Bayer threshold in [-0.5, 0.5)
      float bayer(vec2 p) {
        vec2 q = mod(floor(p), 4.0);
        int i = int(q.x) + int(q.y) * 4;
        float m[16];
        m[0]=0.;m[1]=8.;m[2]=2.;m[3]=10.;m[4]=12.;m[5]=4.;m[6]=14.;m[7]=6.;
        m[8]=3.;m[9]=11.;m[10]=1.;m[11]=9.;m[12]=15.;m[13]=7.;m[14]=13.;m[15]=5.;
        float v = 0.0;
        for (int k = 0; k < 16; k++) if (k == i) v = m[k];
        return v / 16.0 - 0.5;
      }
      // nearest palette colour, compared with luma weighted heavier so brightness reads right
      vec3 nearestPal(vec3 g) {
        vec3 best = pal[0];
        float bd = 1e9;
        for (int k = 0; k < PAL_N; k++) {
          vec3 e = g - pal[k];
          float dl = dot(e, vec3(0.299, 0.587, 0.114));
          float dd = dot(e, e) + 2.0 * dl * dl;
          if (dd < bd) { bd = dd; best = pal[k]; }
        }
        return best;
      }

      void main() {
        vec2 px = floor(vUv * res);
        vec2 uv = (px + 0.5) / res; // centre of the coarse pixel this screen pixel falls in
        vec2 d = uv - 0.5;
        vec2 off = floor(d * length(d) * amount * 2.0 * res + 0.5) / res; // colour split moves in whole pixels
        vec3 c = vec3(
          texture2D(tDiffuse, uv + off).r,
          texture2D(tDiffuse, uv).g,
          texture2D(tDiffuse, uv - off).b);
        c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14); // filmic curve: soft highlights, deeper shade
        c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, saturation);
        c *= 1.0 - vignette * smoothstep(0.25, 0.85, length(d));

        // to display (gamma) space, where the palette is defined
        vec3 g = pow(max(c, 0.0), vec3(1.0 / 2.2));
        // light and shadow at depth edges, before the palette match so they land on palette colours
        vec2 t = 1.0 / res;
        float z = linDepth(uv);
        float zl = linDepth(uv - vec2(t.x, 0.0)), zr = linDepth(uv + vec2(t.x, 0.0));
        float zu = linDepth(uv + vec2(0.0, t.y)), zd = linDepth(uv - vec2(0.0, t.y));
        float tol = 0.06 * z + 0.05;
        float behind = step(tol, z - min(min(zl, zr), min(zu, zd))); // just past a nearer silhouette
        float topEdge = step(tol * 2.0, zu - z); // the sky or far wall right above: a lit upper rim
        g = mix(g, g * shade, behind);
        g += rim * topEdge * (1.0 - behind) * vec3(1.0, 0.92, 0.78);
        g = nearestPal(clamp(g + bayer(px) * palDither, 0.0, 1.0));

        gl_FragColor = vec4(pow(g, vec3(2.2)), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const quad = new FullScreenQuad(material);

  return {
    render() {
      material.uniforms.near.value = camera.near;
      material.uniforms.far.value = camera.far;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      quad.render(renderer);
    },
    resize(w: number, h: number) {
      const ph = Math.max(1, Math.min(PIXEL_HEIGHT, Math.round(h * renderer.getPixelRatio())));
      const pw = Math.max(1, Math.round((ph * w) / h));
      target.setSize(pw, ph);
      material.uniforms.res.value.set(pw, ph);
    },
    setChroma(v: number) {
      material.uniforms.amount.value = v;
    },
  };
}
