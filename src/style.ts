import * as THREE from 'three';

/**
 * The game's single art style: clean stylized shapes, saturated colour, smooth light,
 * no surface noise. Every material — arena, sand, props, player — comes from here.
 *
 * Built on Lambert shading (the cheapest lit material) with an optional warm rim light,
 * so the look costs almost nothing per pixel.
 */
export const PALETTE = {
  stone: 0xe6c794,
  stoneDark: 0xcda672,
  marble: 0xf7ecd6,
  wood: 0xb06c3a,
  woodDark: 0x7a4829,
  iron: 0x4b4654,
  straw: 0xdcc084,
  banner: 0xc5352f,
  gold: 0xf4b836,
  linen: 0xe9dcc0,
  leather: 0x74452a,
  hair: 0x4a3324,
  shadowSky: 0x8f86d8, // dusk fill from the sky: shade leans violet
  bounce: 0xd08a5c, // warm light bounced off the sand
  glow: 0xff9a5a, // sunset light thrown back by the lit stands
  sun: 0xff8a3a,
};

/** Unit vector pointing at the sun: sunset, so the sand is in the stadium's shade and only the far stands catch light. */
export const SUN_DIR = new THREE.Vector3(-0.67, 0, 0.38).normalize().multiplyScalar(Math.cos(0.28)).setY(Math.sin(0.28));

/**
 * The stadium's own shadow is computed analytically in every material instead of with a
 * huge shadow map: a point is in shade when the ray toward the sun passes below the rim of
 * the bowl. x = rim radius, y = rim height, z = depth of the fascia hanging below the rim.
 * The arena fills these in once it knows its dimensions.
 */
export const bowl = { value: new THREE.Vector3(1e4, 0, 0) };
const sunDir = { value: SUN_DIR };

const BOWL_PARS = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uBowl;
varying vec3 vWorld;
float bowlLight( vec3 p ) {
	vec2 o = p.xz, d = uSunDir.xz;
	float a = dot( d, d ), b = dot( o, d ), c = dot( o, o ) - uBowl.x * uBowl.x;
	float disc = b * b - a * c;
	if ( disc <= 0.0 ) return 0.0;
	float root = sqrt( disc ), t1 = ( -b - root ) / a, t2 = ( -b + root ) / a;
	if ( t2 <= 0.0 ) return 0.0; // behind the sunward wall
	float y2 = p.y + t2 * uSunDir.y;
	float lit = smoothstep( uBowl.y - 0.15 - t2 * 0.03, uBowl.y + 0.15 + t2 * 0.03, y2 );
	// under the gallery roof: light must first slip in beneath the fascia on the far side
	if ( c > 0.0 ) lit *= step( p.y + t1 * uSunDir.y, uBowl.y - uBowl.z );
	return lit;
}`;

export interface MatOptions {
  side?: THREE.Side;
  /** Strength of the warm edge light (0 = off). Use on characters and props, not big flat walls. */
  rim?: number;
  vertexColors?: boolean;
  map?: THREE.Texture | null;
}

export function mat(color: THREE.ColorRepresentation, o: MatOptions = {}): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({
    color,
    side: o.side ?? THREE.FrontSide,
    vertexColors: o.vertexColors ?? false,
    map: o.map ?? null,
  });
  const rim = o.rim ?? 0;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDir = sunDir;
    shader.uniforms.uBowl = bowl;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
	vec4 bowlPos = vec4( transformed, 1.0 );
	#ifdef USE_INSTANCING
		bowlPos = instanceMatrix * bowlPos;
	#endif
	vWorld = ( modelMatrix * bowlPos ).xyz;`,
      );
    let frag = shader.fragmentShader
      .replace('#include <common>', '#include <common>' + BOWL_PARS)
      .replace(
        '#include <lights_fragment_begin>',
        THREE.ShaderChunk.lights_fragment_begin.replace(
          'getDirectionalLightInfo( directionalLight, directLight );',
          'getDirectionalLightInfo( directionalLight, directLight );\n\t\tif ( UNROLLED_LOOP_INDEX == 0 ) directLight.color *= bowlLight( vWorld ); // sun only',
        ),
      );
    if (rim > 0)
      frag = frag.replace(
        '#include <opaque_fragment>',
        `float rimF = pow( 1.0 - saturate( dot( normalize( vViewPosition ), normal ) ), 3.0 );
	outgoingLight += diffuseColor.rgb * vec3( 1.0, 0.86, 0.62 ) * rimF * ${rim.toFixed(3)} * ( 0.35 + 0.65 * bowlLight( vWorld ) );
	#include <opaque_fragment>`,
      );
    shader.fragmentShader = frag;
  };
  m.customProgramCacheKey = () => `style-rim${rim.toFixed(3)}`;
  return m;
}

/** Shadow-casting, shadow-receiving mesh. */
export function solid(geo: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Simplify a painted texture to match the style: fine brush detail is blurred away and
 * contrast pulled toward the average, leaving only broad shapes.
 */
export function simplifyTexture(src: THREE.Texture, blur = 0.7, flatten = 0.35): THREE.Texture {
  const img = src.image as CanvasImageSource & { width: number; height: number };
  if (!img || !img.width) return src;
  const w = Math.min(img.width, 1024), h = Math.min(img.height, 1024);
  const canvas = (cw: number, ch: number) => {
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    return c;
  };
  // blur by shrinking and stretching back (works in every browser, unlike canvas filters)
  const small = canvas(Math.max(1, w >> 4), Math.max(1, h >> 4));
  const sctx = small.getContext('2d')!;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(img, 0, 0, small.width, small.height);
  const s = sctx.getImageData(0, 0, small.width, small.height).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < s.length; i += 4) {
    r += s[i]; g += s[i + 1]; b += s[i + 2];
  }
  const n = s.length / 4;
  const out = canvas(w, h);
  const ctx = out.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.globalAlpha = blur;
  ctx.drawImage(small, 0, 0, w, h);
  ctx.globalAlpha = flatten;
  ctx.fillStyle = `rgb(${r / n},${g / n},${b / n})`;
  ctx.fillRect(0, 0, w, h);

  const tex = new THREE.CanvasTexture(out);
  tex.flipY = src.flipY;
  tex.colorSpace = src.colorSpace;
  tex.wrapS = src.wrapS;
  tex.wrapT = src.wrapT;
  tex.anisotropy = 4;
  return tex;
}
