// A cursor trail behind the whole page, after rock-biter/cursor-trail.
//
// The technique is a feedback buffer. Each frame samples the frame before it
// through a curl-noise displacement, fades what it found, and deposits colour
// where the pointer is: a wide soft pool, a tighter ring, and a hot core. Two
// textures take turns being read and written, so the smoke is the previous
// frame smeared and dimmed rather than a list of past positions.
//
// The original carries three.js to draw one fullscreen quad. This page ships
// no libraries, and a quad is not worth 600KB, so it is raw WebGL2: one
// triangle, two framebuffers, the same maths.
//
// Two departures beyond the palette. It renders at half resolution, because
// the result is smoke and nobody can see the difference while the curl noise
// costs real time per pixel. And the simulation stores colour only; alpha is
// computed when the buffer is drawn to screen, so the canvas composites over
// the page instead of painting a black rectangle across it.

(() => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const canvas = document.createElement("canvas");
  canvas.className = "trailfx";
  canvas.setAttribute("aria-hidden", "true");
  document.body.prepend(canvas);
  // Only the page that loads this script lifts its content above the canvas,
  // so the rule cannot reach a page that has no trail.
  document.body.classList.add("has-trail");

  const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, depth: false });
  // No WebGL2 is not a failure worth reporting: the page reads the same
  // without it.
  if (!gl) return;

  const VERT = `#version 300 es
  void main() {
    // One oversized triangle instead of a quad: no shared edge to interpolate
    // across, and three vertices rather than six.
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  const NOISE = `
  vec4 permute(vec4 x){return mod(x*x*34.+x,289.);}
  float snoise(vec3 v){
    const vec2 C = 1./vec2(6,3);
    const vec4 D = vec4(0,.5,1,2);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1. - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.x;
    vec3 x2 = x0 - i2 + C.y;
    vec3 x3 = x0 - D.yyy;
    i = mod(i,289.);
    vec4 p = permute(permute(permute(
        i.z + vec4(0., i1.z, i2.z, 1.))
      + i.y + vec4(0., i1.y, i2.y, 1.))
      + i.x + vec4(0., i1.x, i2.x, 1.));
    vec3 ns = .142857142857 * D.wyz - D.xzx;
    vec4 j = p - 49. * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = floor(j - 7. * x_) * ns.x + ns.yyyy;
    vec4 h = 1. - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 sh = -step(h, vec4(0));
    vec4 a0 = b0.xzyw + (floor(b0)*2.+1.).xzyw*sh.xxyy;
    vec4 a1 = b1.xzyw + (floor(b1)*2.+1.).xzyw*sh.zzww;
    vec3 p0 = vec3(a0.xy,h.x);
    vec3 p1 = vec3(a0.zw,h.y);
    vec3 p2 = vec3(a1.xy,h.z);
    vec3 p3 = vec3(a1.zw,h.w);
    vec4 norm = inversesqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.);
    return .5 + 12. * dot(m*m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }
  vec3 snoiseVec3(vec3 x){
    return vec3(snoise(vec3(x)*2.-1.),
                snoise(vec3(x.y-19.1, x.z+33.4, x.x+47.2))*2.-1.,
                snoise(vec3(x.z+74.2, x.x-124.5, x.y+99.4)*2.-1.));
  }
  vec3 curlNoise(vec3 p){
    const float e = .1;
    vec3 dx = vec3(e,0,0), dy = vec3(0,e,0), dz = vec3(0,0,e);
    vec3 px0 = snoiseVec3(p-dx), px1 = snoiseVec3(p+dx);
    vec3 py0 = snoiseVec3(p-dy), py1 = snoiseVec3(p+dy);
    vec3 pz0 = snoiseVec3(p-dz), pz1 = snoiseVec3(p+dz);
    float x = py1.z - py0.z - pz1.y + pz0.y;
    float y = pz1.x - pz0.x - px1.z + px0.z;
    float z = px1.y - px0.y - py1.x + py0.x;
    return normalize(vec3(x,y,z) * (1.0 / (2.0 * e)));
  }`;

  // The deposit colours are the site's: the payment spectrum the rest of the
  // page already uses, hottest at the cursor.
  const SIM = `#version 300 es
  precision highp float;
  uniform vec2 uResolution;
  uniform sampler2D uMap;
  uniform vec2 uPointer;
  uniform float uDt;
  uniform float uSpeed;
  uniform float uTime;
  uniform float uActive;
  out vec4 fragColor;
  ${NOISE}
  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;

    vec2 uv2 = uv + curlNoise(vec3(uv * 4. + uTime * 0.1, uTime * 0.1)).xy * uDt * 0.3;
    uv += curlNoise(vec3(uv * 2. + uTime * 0.1, uTime * 0.1)).xy * uDt * 0.15;

    vec3 a = texture(uMap, uv).rgb;
    vec3 b = texture(uMap, uv2).rgb;
    vec3 color = mix(a, b, 0.5);
    color *= 1. - uDt * 2.;

    uv -= 0.5;
    uv *= 2.0;
    uv.x *= uResolution.x / uResolution.y;
    vec2 pointer = uPointer;
    pointer.x *= uResolution.x / uResolution.y;

    float d = distance(uv, pointer);
    float speed = clamp(uSpeed * 2., 0.075, 0.25);
    float scale = speed * 5. * uActive;

    float t  = smoothstep(speed, 0., d) * scale;
    float t3 = pow(smoothstep(speed, 0., d), 4.) * scale;
    float t2 = pow(smoothstep(speed, 0., d), 10.) * scale;

    color = mix(color, vec3(0.92, 0.00, 0.10), t);   // --red, the outer pool
    color = mix(color, vec3(1.00, 0.37, 0.00), t3);  // --orange, the body
    color = mix(color, vec3(1.00, 0.93, 0.78), t2);  // the hot core

    fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
  }`;

  // Drawing to screen is where alpha appears: the brightest channel becomes
  // opacity, so unlit pixels are transparent and the page shows through.
  const DRAW = `#version 300 es
  precision highp float;
  uniform sampler2D uMap;
  uniform vec2 uResolution;
  uniform float uFade;
  out vec4 fragColor;
  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec3 c = texture(uMap, uv).rgb;
    float a = max(max(c.r, c.g), c.b);
    fragColor = vec4(c, a * uFade);
  }`;

  function compile(src, type) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn("trail:", gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  }

  function program(fragSrc) {
    const v = compile(VERT, gl.VERTEX_SHADER);
    const f = compile(fragSrc, gl.FRAGMENT_SHADER);
    if (!v || !f) return null;
    const p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn("trail:", gl.getProgramInfoLog(p));
      return null;
    }
    return p;
  }

  const sim = program(SIM);
  const draw = program(DRAW);
  if (!sim || !draw) return;

  const vao = gl.createVertexArray();
  let targets = [];
  let w = 0;
  let h = 0;

  function makeTarget(width, height) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // Clamped, not repeated: a trail that wrapped round the edge would draw
    // smoke on the opposite side of the screen from the cursor.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fb };
  }

  function resize() {
    // The canvas is fixed to the viewport, so its cost does not grow with the
    // length of the page: a long page scrolls under a trail the same size as
    // a short one.
    const r = { width: innerWidth, height: innerHeight };
    // Half resolution. It is smoke; the curl noise is the expensive part and
    // it costs per pixel.
    const next = [Math.max(1, Math.round(r.width / 2)), Math.max(1, Math.round(r.height / 2))];
    if (next[0] === w && next[1] === h) return;
    [w, h] = next;
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${r.width}px`;
    canvas.style.height = `${r.height}px`;
    for (const t of targets) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fb);
    }
    targets = [makeTarget(w, h), makeTarget(w, h)];
  }

  // Pointer in the shader's space: centred, y up, x scaled by aspect later.
  const pointer = { x: 0, y: 0, px: 0, py: 0, speed: 0, seen: false };

  addEventListener(
    "pointermove",
    (ev) => {
      // clientX/Y are already viewport coordinates, which is what a fixed
      // canvas wants; no scroll offset belongs in here.
      pointer.x = (ev.clientX / innerWidth) * 2 - 1;
      pointer.y = (1 - ev.clientY / innerHeight) * 2 - 1;
      pointer.seen = true;
    },
    { passive: true },
  );

  let src = 0;
  let last = performance.now();

  function frame(now) {
    requestAnimationFrame(frame);
    // The canvas covers the viewport, so there is nothing to scroll out of
    // view and nothing to observe. A hidden tab is still worth stopping for.
    if (document.hidden) return;

    resize();
    // Clamped: a tab restored after a minute would otherwise arrive with a
    // delta that wipes the buffer and jumps the trail across the screen.
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;

    const dx = pointer.x - pointer.px;
    const dy = pointer.y - pointer.py;
    pointer.speed = Math.hypot(dx, dy);
    pointer.px = pointer.x;
    pointer.py = pointer.y;

    gl.bindVertexArray(vao);

    // simulate into the target that is not being read
    const dst = 1 - src;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets[dst].fb);
    gl.viewport(0, 0, w, h);
    gl.useProgram(sim);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targets[src].tex);
    gl.uniform1i(gl.getUniformLocation(sim, "uMap"), 0);
    gl.uniform2f(gl.getUniformLocation(sim, "uResolution"), w, h);
    gl.uniform2f(gl.getUniformLocation(sim, "uPointer"), pointer.x, pointer.y);
    gl.uniform1f(gl.getUniformLocation(sim, "uDt"), dt);
    gl.uniform1f(gl.getUniformLocation(sim, "uSpeed"), pointer.speed);
    gl.uniform1f(gl.getUniformLocation(sim, "uTime"), now / 1000);
    gl.uniform1f(gl.getUniformLocation(sim, "uActive"), pointer.seen ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // and to the screen, where it gains alpha
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(draw);
    gl.bindTexture(gl.TEXTURE_2D, targets[dst].tex);
    gl.uniform1i(gl.getUniformLocation(draw, "uMap"), 0);
    gl.uniform2f(gl.getUniformLocation(draw, "uResolution"), w, h);
    gl.uniform1f(gl.getUniformLocation(draw, "uFade"), 0.85);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    src = dst;
  }

  resize();
  requestAnimationFrame(frame);
})();
