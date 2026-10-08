import * as THREE from 'three/webgpu';
import { Fn, float, normalView, positionViewDirection, screenSize, select, uv, vec2, vec3, vec4 } from 'three/tsl';

type TextureNode = ReturnType<THREE.PassNode['getTextureNode']>;

/**
 * Warm rim light: silhouettes catch a soft stroke of forge light, which reads as
 * the "edge highlight" a painter adds. Used as an emissive term on painted surfaces.
 */
export function rimLight(color: THREE.ColorRepresentation = '#ffb070', strength = 0.22, power = 3.0) {
  const c = new THREE.Color(color);
  const facing = normalView.dot(positionViewDirection).clamp(0, 1);
  return vec3(c.r, c.g, c.b).mul(float(1).sub(facing).pow(power).mul(strength));
}

/**
 * Kuwahara filter: each pixel takes the mean colour of whichever of its four
 * neighbouring quadrants is the most uniform. Flat areas become soft dabs of paint
 * while edges stay crisp. Costs (r+1)^2 * 4 samples per pixel, so desktop only.
 */
export function kuwahara(input: TextureNode, radius = 2) {
  return Fn(() => {
    const texel = vec2(1, 1).div(screenSize);
    const n = (radius + 1) * (radius + 1);
    const quads = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => {
      let sum: THREE.Node<'vec3'> = vec3(0, 0, 0);
      let sq: THREE.Node<'vec3'> = vec3(0, 0, 0);
      for (let i = 0; i <= radius; i++) {
        for (let j = 0; j <= radius; j++) {
          const c = input.sample(uv().add(vec2(sx! * i, sy! * j).mul(texel))).rgb;
          sum = sum.add(c);
          sq = sq.add(c.mul(c));
        }
      }
      const mean = sum.div(n);
      const v = sq.div(n).sub(mean.mul(mean));
      return { mean, variance: v.x.add(v.y).add(v.z) };
    });
    // Pick the quadrant with the lowest variance.
    let best = quads[0]!.mean;
    let bestV = quads[0]!.variance;
    for (const q of quads.slice(1)) {
      const better = q.variance.lessThan(bestV);
      best = select(better, q.mean, best);
      bestV = select(better, q.variance, bestV);
    }
    return vec4(best, 1);
  })();
}
