import * as THREE from 'three';

/**
 * The game's single art style: the look of a 3D animated show. Smooth rounded shapes,
 * saturated colour and soft physically based light, with no ink outlines. Surfaces carry
 * only broad, painterly texture (stone blocks, wood grain, cloth weave) projected triplanar
 * so no mesh needs UVs. Every material — arena, sand, props, player — comes from here.
 */
export const PALETTE = {
  stone: 0xe0c392,
  stoneDark: 0xc7a371,
  marble: 0xf3e8d3,
  wood: 0xa9683a,
  woodDark: 0x76462a,
  iron: 0x4c4856,
  straw: 0xd8bc80,
  banner: 0xc0342e,
  gold: 0xecb23a,
  linen: 0xe6d9be,
  leather: 0x71432a,
  crimson: 0x9a2e2a,
  rope: 0xb89a62,
  bronze: 0xc08a3e,
  steel: 0xc4c7cf,
  hair: 0x47311f,
  sandCrest: 0xf0d19a,
  sandHollow: 0xdcab6c,
  shadowSky: 0x8f88d2, // dusk fill from the sky: shade leans violet
  bounce: 0xcc885c, // warm light bounced off the sand
  glow: 0xff9a5a, // sunset light thrown back by the lit stands
  sun: 0xff9244,
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


// ---------------------------------------------------------------------------------------
// Surface textures: small tiling greyscale height/tone maps, generated once at startup.
// 0.5 is neutral; the shader uses them to vary colour, roughness and the surface normal.
// ---------------------------------------------------------------------------------------

function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Tileable value noise, period `px` × `py` cells. */
export function vnoise(x: number, y: number, px: number, py = px) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const wx = (n: number) => ((n % px) + px) % px, wy = (n: number) => ((n % py) + py) % py;
  const a = hash(wx(xi), wy(yi)), b = hash(wx(xi + 1), wy(yi)), c = hash(wx(xi), wy(yi + 1)), d = hash(wx(xi + 1), wy(yi + 1));
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Tileable fractal noise in 0..1, starting at `f` cells per tile. */
function fbm(u: number, v: number, f: number, octaves: number) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < octaves; o++, f *= 2, amp *= 0.5) {
    sum += vnoise(u * f + o * 17, v * f + o * 31, f) * amp;
    norm += amp;
  }
  return sum / norm;
}

export type Surface = 'stone' | 'marble' | 'sand' | 'wood' | 'cloth' | 'leather' | 'metal' | 'skin';

const PAINTERS: Record<Exclude<Surface, 'skin'>, (u: number, v: number) => number> = {
  // weathered limestone: cloudy mottling, faint horizontal bedding, scattered pits
  stone(u, v) {
    let h = 0.5 + (fbm(u, v, 4, 6) - 0.5) * 1.1;
    h += 0.05 * Math.sin((v * 9 + vnoise(u * 5, v * 5, 5) * 0.8) * Math.PI * 2);
    const pit = vnoise(u * 56 + 9, v * 56 + 3, 56);
    if (pit > 0.74) h -= (pit - 0.74) * 1.6;
    return h;
  },
  // polished marble: soft clouds cut by thin dark veins
  marble(u, v) {
    const warp = fbm(u, v, 3, 4);
    const vein = Math.abs(fbm(u + warp * 0.25, v + warp * 0.25, 3, 5) - 0.5);
    return 0.56 + (warp - 0.5) * 0.35 - 0.4 * Math.max(0, 1 - vein / 0.035) ** 2;
  },
  // arena sand: per-grain speckle over fine clumps, the odd darker pebble
  sand(u, v) {
    let h = 0.5 + (fbm(u, v, 12, 3) - 0.5) * 0.5 + (fbm(u, v, 4, 2) - 0.5) * 0.35;
    const peb = vnoise(u * 40 + 5, v * 40 + 11, 40);
    if (peb > 0.83) h -= (peb - 0.83) * 2.6;
    return h;
  },
  // sawn timber: long grain running along v, occasional darker streak
  wood(u, v) {
    const wobble = vnoise(u * 4, v * 3, 4, 3) * 0.06;
    const grain = vnoise((u + wobble) * 56, v * 3, 56, 3), fine = vnoise((u + wobble) * 160, v * 8, 160, 8);
    const streak = Math.max(0, vnoise((u + wobble) * 14 + 3, v * 2, 14, 2) - 0.62) * 1.2;
    return 0.52 + (grain - 0.5) * 0.6 + (fine - 0.5) * 0.3 - streak;
  },
  // hand-woven linen: plain weave whose threads vary in thickness (slubs), over uneven dye
  cloth(u, v) {
    const warp = Math.sin(u * Math.PI * 2 * 72), weft = Math.sin(v * Math.PI * 2 * 72);
    const slubU = vnoise(u * 72, v * 5, 72, 5) - 0.5, slubV = vnoise(u * 5 + 3, v * 72, 5, 72) - 0.5;
    return 0.5 + warp * weft * 0.2 + (warp + weft) * 0.06 + (slubU + slubV) * 0.16 + (fbm(u, v, 6, 3) - 0.5) * 0.3;
  },
  // tanned hide: fine pebbled grain, a few wandering creases
  leather(u, v) {
    const crease = Math.max(0, 1 - Math.abs(fbm(u, v, 5, 3) - 0.5) / 0.03) ** 2;
    return 0.52 + (fbm(u, v, 28, 3) - 0.5) * 0.55 + (fbm(u, v, 4, 2) - 0.5) * 0.25 - crease * 0.28;
  },
  // forged metal: hammer mottling, fine pitting
  metal(u, v) {
    return 0.5 + (fbm(u, v, 6, 3) - 0.5) * 0.9;
  },
};

const detailCache = new Map<string, THREE.Texture>();
function detailTexture(kind: Exclude<Surface, 'skin'>): THREE.Texture {
  let tex = detailCache.get(kind);
  if (tex) return tex;
  const size = 256, data = new Uint8Array(size * size * 4), paint = PAINTERS[kind];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const l = Math.round(THREE.MathUtils.clamp(paint(x / size, y / size), 0, 1) * 255);
      data.set([l, l, l, 255], (y * size + x) * 4);
    }
  tex = new THREE.DataTexture(data, size, size);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  detailCache.set(kind, tex);
  return tex;
}

/** Per-surface look. tile: metres per texture repeat. tone: colour variation. bump: relief height (m). gloss: how much the texture varies roughness. */
const SURFACES: Record<Surface, { roughness: number; metalness: number; tile: number; tone: number; bump: number; gloss: number }> = {
  stone: { roughness: 0.85, metalness: 0, tile: 5.0, tone: 0.1, bump: 0.003, gloss: 0.05 },
  marble: { roughness: 0.45, metalness: 0, tile: 3.0, tone: 0.1, bump: 0, gloss: 0.1 },
  sand: { roughness: 0.95, metalness: 0, tile: 3.0, tone: 0.08, bump: 0.002, gloss: 0 },
  wood: { roughness: 0.65, metalness: 0, tile: 0.7, tone: 0.2, bump: 0.001, gloss: 0.15 },
  cloth: { roughness: 0.92, metalness: 0, tile: 0.3, tone: 0.13, bump: 0.0008, gloss: 0 },
  leather: { roughness: 0.6, metalness: 0, tile: 0.25, tone: 0.16, bump: 0.0008, gloss: 0.22 },
  metal: { roughness: 0.38, metalness: 0.8, tile: 0.6, tone: 0.12, bump: 0.0008, gloss: 0.2 },
  skin: { roughness: 0.55, metalness: 0, tile: 1, tone: 0, bump: 0, gloss: 0 },
};

const DETAIL_PARS = /* glsl */ `
uniform sampler2D uDetail;
uniform vec4 uDetailCfg; // 1/tile, tone, bump, gloss
varying vec3 vLocal;
float blockHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }`;

// colour: triplanar tone map, then (stonework only) cut-stone blocks laid in rings around the arena axis
const DETAIL_COLOR = /* glsl */ `
	vec3 triW = abs( normalize( cross( dFdx( vLocal ), dFdy( vLocal ) ) ) );
	triW = pow( triW, vec3( 6.0 ) );
	triW /= triW.x + triW.y + triW.z;
	vec3 triP = vLocal * uDetailCfg.x;
	float detail = texture2D( uDetail, triP.zy ).r * triW.x + texture2D( uDetail, triP.xz ).r * triW.y + texture2D( uDetail, triP.xy ).r * triW.z;
	diffuseColor.rgb *= 1.0 + ( detail - 0.5 ) * 2.0 * uDetailCfg.y;
	#ifdef ASHLAR
		vec3 faceN = normalize( cross( dFdx( vWorld ), dFdy( vWorld ) ) );
		float rad = length( vWorld.xz );
		float around = atan( vWorld.x, vWorld.z ) / 6.2831853 * ( rad > 33.6 ? 132.0 : 66.0 );
		// treads: two rows of slabs per step; walls: courses 0.725 m tall (two per riser)
		vec2 block = abs( faceN.y ) > 0.5 ? vec2( around, ( rad - 23.2 ) / 0.95 ) : vec2( around, vWorld.y / 0.725 );
		block.x += 0.5 * mod( floor( block.y ), 2.0 ); // running bond
		vec2 bf = fract( block ), bw = fwidth( block );
		vec2 jw = vec2( 0.012, 0.028 ) + bw * 1.5; // wide, soft joints
		vec2 edge = smoothstep( vec2( 0.0 ), jw, bf ) * smoothstep( vec2( 0.0 ), jw, 1.0 - bf );
		float joint = ( 1.0 - edge.x * edge.y ) * ( 1.0 - smoothstep( 0.06, 0.3, max( bw.x, bw.y ) ) );
		float blockTone = blockHash( floor( block ) );
		diffuseColor.rgb *= ( 0.95 + 0.09 * blockTone ) * ( 1.0 - 0.2 * joint );
		diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.04, 0.99, 0.93 ), step( 0.7, blockTone ) ); // some blocks from a warmer quarry bed
		detail -= joint * 0.2;
	#endif`;

// relief: tilt the surface normal by the texture's screen-space slope
const DETAIL_BUMP = /* glsl */ `
	{
		vec2 dH = vec2( dFdx( detail ), dFdy( detail ) ) * uDetailCfg.z;
		vec3 sx = dFdx( - vViewPosition ), sy = dFdy( - vViewPosition );
		vec3 r1 = cross( sy, normal ), r2 = cross( normal, sx );
		float det = dot( sx, r1 ) * faceDirection;
		normal = normalize( abs( det ) * normal - sign( det ) * ( dH.x * r1 + dH.y * r2 ) );
	}`;

export interface MatOptions {
  side?: THREE.Side;
  vertexColors?: boolean;
  map?: THREE.Texture | null;
  /** What the thing is made of: picks roughness, metalness and the surface texture. */
  surface?: Surface;
  /** Stonework only: draw cut-stone block courses (assumes the piece is built around the arena axis). */
  ashlar?: boolean;
  /** Strength of the warm edge light (0 = off). Use on characters and props, not big flat walls. */
  rim?: number;
  /** Deforming meshes (simulated cloth): take texture coordinates from an `aRest` attribute so the weave sticks to the fabric. */
  rest?: boolean;
}

export function mat(color: THREE.ColorRepresentation, o: MatOptions = {}): THREE.MeshStandardMaterial {
  const surface = o.surface ?? 'stone', cfg = SURFACES[surface];
  const detailed = surface !== 'skin', ashlar = detailed && !!o.ashlar;
  const m = new THREE.MeshStandardMaterial({
    color,
    side: o.side ?? THREE.FrontSide,
    vertexColors: o.vertexColors ?? false,
    map: o.map ?? null,
    roughness: cfg.roughness,
    metalness: cfg.metalness,
  });
  const detail = detailed ? { value: detailTexture(surface) } : null;
  const rim = o.rim ?? 0, rest = !!o.rest;
  const detailCfg = { value: new THREE.Vector4(1 / cfg.tile, cfg.tone, cfg.bump, cfg.gloss) };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDir = sunDir;
    shader.uniforms.uBowl = bowl;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;\nvarying vec3 vLocal;' + (rest ? '\nattribute vec3 aRest;' : ''))
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
	vec4 bowlPos = vec4( transformed, 1.0 );
	#ifdef USE_INSTANCING
		bowlPos = instanceMatrix * bowlPos;
	#endif
	vWorld = ( modelMatrix * bowlPos ).xyz;
	vLocal = ${rest ? 'aRest' : 'position'};`,
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
    if (detail) {
      shader.uniforms.uDetail = detail;
      shader.uniforms.uDetailCfg = detailCfg;
      frag = frag
        .replace('#include <common>', (ashlar ? '#define ASHLAR\n' : '') + '#include <common>' + DETAIL_PARS)
        .replace('#include <color_fragment>', '#include <color_fragment>' + DETAIL_COLOR)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = clamp( roughnessFactor + ( 0.5 - detail ) * uDetailCfg.w, 0.05, 1.0 );')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>' + DETAIL_BUMP);
    }
    if (rim > 0)
      frag = frag.replace(
        '#include <opaque_fragment>',
        `float rimF = pow( 1.0 - saturate( dot( normalize( vViewPosition ), normal ) ), 3.0 );
	outgoingLight += diffuseColor.rgb * vec3( 1.0, 0.86, 0.62 ) * rimF * ${rim.toFixed(3)} * ( 0.35 + 0.65 * bowlLight( vWorld ) );
	#include <opaque_fragment>`,
      );
    shader.fragmentShader = frag;
  };
  m.customProgramCacheKey = () => `style-${detailed ? 'detail' : 'plain'}${ashlar ? '-ashlar' : ''}-rim${rim.toFixed(3)}${rest ? '-rest' : ''}`;
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
