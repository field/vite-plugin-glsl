#version 300 es

precision highp float;

in vec2 vUv;
out vec4 fragColor;

// Included from an npm package ("glsl-noise") installed in "node_modules":
#include glsl-noise/simplex/2d.glsl

void main (void) {
  float noise = snoise(vUv * 4.0) * 0.5 + 0.5;
  fragColor = vec4(vec3(noise), 1.0);
}
