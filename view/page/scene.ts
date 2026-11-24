/// <reference types="webxr" />
/**
 * Puts the view's canvases in the room: textured quads in a WebXR immersive-ar session (the room
 * stays visible behind them), or on a desktop canvas with an overview camera outside the headset.
 * Hands and controllers arrive as WebXR input sources; each points a ray, and select is a pinch
 * or a trigger.
 */

export type Mat = Float32Array;
export interface Surface {
  canvas: HTMLCanvasElement;
  /** Size in metres; height follows the canvas's aspect. */
  width: number;
  /** Where the surface sits, before the recenter anchor. */
  pose: Mat;
  dirty: boolean;
  texture: WebGLTexture | null;
}
export interface Hit { surface: string; x: number; y: number }
export type Pointer = 'select-start' | 'select-end' | 'select' | 'squeeze-start' | 'squeeze-end' | 'button-start' | 'button-end';
/** A rectangle on a surface's canvas, in its pixels: what a pointer is over. */
export interface Rect { x: number; y: number; w: number; h: number }
/** Which edge of a surface the pointer is over for a resize grab. */
export type EdgeDir = 'top' | 'bottom' | 'left' | 'right';

export interface SceneEvents {
  pointer(event: Pointer, hit: Hit | null): void;
  /** Scroll by this many rows; positive goes back in history (thumbstick, wheel). */
  scroll(rows: number): void;
  /** Surfaces whose content can be grabbed and dragged (the front session). */
  draggable(surface: string): boolean;
  /** A grabbed surface moved this many of its canvas pixels; positive is down. */
  drag(surface: string, dy: number): void;
  /** A group bar whose grab moves a whole group; true means the ray moves the group. */
  groupBar(surface: string): boolean;
  /** A bar grab just started at pos (anchor-local XYZ of bar centre). */
  groupBarStart(surface: string, pos: [number, number, number]): void;
  /**
   * A bar grab moved: pos is the ray's intersection with the cylinder at the group's radius,
   * in the anchor's local frame. main.ts uses azimuth + height to reposition the group.
   */
  groupMove(surface: string, pos: [number, number, number]): void;
  /** Immersive-AR visibility state changed (visible | visible-blurred | hidden). */
  visibilityChange?(state: string): void;
  /** Runs before each frame is drawn, in or out of the headset: the page redraws its canvases here. */
  frame(): void;
  /** The control under a pointer, to highlight; null when there is nothing to select there. */
  target(hit: Hit): Rect | null;
  /** Whether this surface's edges can be grabbed to resize its group. */
  edgeResize(surface: string): boolean;
  /**
   * An edge grab just started on `surface`. main.ts records the current group scale as scale0
   * for ratio tracking.
   */
  edgeStart(surface: string): void;
  /**
   * An edge grab moved: ratio = newDist / initDist where both are distances from the head to
   * the ray–surface intersection. main.ts applies scale0 × ratio, clamped to [0.6, 1.8].
   */
  edgeMove(surface: string, ratio: number): void;
}

// ---- Matrices (column-major, as WebGL and WebXR use) -----------------------------------------

export function multiply(a: Mat, b: Mat): Mat {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) {
    let s = 0;
    for (let k = 0; k < 4; k += 1) s += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
    o[c * 4 + r] = s;
  }
  return o;
}
export function identity(): Mat { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
/** Rotation about Y by `yaw` radians, then translation. */
export function pose(x: number, y: number, z: number, yaw = 0): Mat {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, y, z, 1]);
}
/** A surface on a circle around the owner at `degrees` right of straight ahead, facing them. */
export function onArc(degrees: number, y: number, radius: number): Mat {
  const a = degrees * Math.PI / 180;
  return pose(Math.sin(a) * radius, y, -Math.cos(a) * radius, -a);
}
function invertRigid(m: Mat): Mat {
  const o = new Float32Array(16);
  for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) o[c * 4 + r] = m[r * 4 + c] as number;
  for (let r = 0; r < 3; r += 1) o[12 + r] = -((o[r] as number) * (m[12] as number) + (o[4 + r] as number) * (m[13] as number) + (o[8 + r] as number) * (m[14] as number));
  o[15] = 1;
  return o;
}
function apply(m: Mat, v: [number, number, number], w: number): [number, number, number] {
  return [0, 1, 2].map(r => (m[r] as number) * v[0] + (m[4 + r] as number) * v[1] + (m[8 + r] as number) * v[2] + (m[12 + r] as number) * w) as [number, number, number];
}
function perspective(fovY: number, aspect: number, near: number, far: number): Mat {
  const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

const VS = `#version 300 es
in vec2 corner; uniform mat4 mvp; uniform vec2 size; out vec2 uv;
void main() { uv = vec2(corner.x + 0.5, 0.5 - corner.y); gl_Position = mvp * vec4(corner * size, 0.0, 1.0); }`;
const FS = `#version 300 es
precision mediump float; in vec2 uv; uniform sampler2D tex; uniform vec4 solid; uniform float round; out vec4 colour;
void main() {
  if (solid.a > 0.0 && round < 0.5) colour = solid;
  else if (solid.a > 0.0) {
    // A pointer: a round dot with a dark rim, so it shows on light and dark alike.
    float d = distance(uv, vec2(0.5));
    if (d > 0.5) discard;
    colour = d > 0.34 ? vec4(0.04, 0.06, 0.09, 1.0) : solid;
  } else colour = texture(tex, uv);
}`;

/** Thumbstick scrolling: rows a second at full push, and the dead zone around the centre. */
const STICK_ROWS_PER_S = 30, STICK_DEAD = 0.15;
/** Fraction of a surface's canvas dimension that counts as an edge strip for resize grabs. */
const EDGE_FRAC = 0.07;

/** Desktop overview camera: a step behind the owner's seat, so the whole shelf is in view. */
const DESKTOP_EYE: [number, number, number] = [0, 0.15, 1.15];

export class Scene {
  readonly surfaces = new Map<string, Surface>();
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly loc: { corner: number; mvp: WebGLUniformLocation | null; size: WebGLUniformLocation | null; solid: WebGLUniformLocation | null; round: WebGLUniformLocation | null };
  private anchor: Mat = pose(0, 0, 0);
  private session: XRSession | null = null;
  private space: XRReferenceSpace | null = null;
  private viewer: Mat | null = null;
  private needsAnchor = false;
  private readonly rays = new Map<XRInputSource, { origin: [number, number, number]; end: [number, number, number]; hit: Hit | null }>();
  /** Inputs whose select is held: their highlight brightens. */
  private readonly pressing = new Set<XRInputSource>();
  /** Inputs whose A/X button was down last frame. */
  private readonly buttonDown = new Set<XRInputSource>();
  /** Joint positions of tracked hands this frame. */
  private joints: [number, number, number][] = [];
  private mousePressed = false;
  /** Grabs in progress: which surface, and the canvas row the pointer was last at. */
  private readonly grabs = new Map<XRInputSource | 'mouse', { surface: string; y: number }>();
  /** Group bar grabs: surface being dragged and the cylinder radius for projection. */
  private readonly barGrabs = new Map<XRInputSource | 'mouse', { surface: string; radius: number }>();
  /** Edge resize grabs: surface, grabbed edge, and initial distance from head to the grab point. */
  private readonly edgeGrabs = new Map<XRInputSource | 'mouse', { surface: string; edge: EdgeDir; initDist: number }>();
  /** The edge currently hovered by the pointer, or null. */
  private currentEdgeHover: { surface: string; edge: EdgeDir } | null = null;
  private lastFrame = 0;
  private mouseHit: Hit | null = null;
  private anisotropy: { ext: EXT_texture_filter_anisotropic; max: number } | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly events: SceneEvents) {
    const gl = canvas.getContext('webgl2', { xrCompatible: true, alpha: true, antialias: true, premultipliedAlpha: true });
    if (!gl) throw new Error('This browser has no WebGL2.');
    this.gl = gl;
    const program = gl.createProgram() as WebGLProgram;
    for (const [type, source] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]] as const) {
      const shader = gl.createShader(type) as WebGLShader;
      gl.shaderSource(shader, source); gl.compileShader(shader); gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    this.program = program;
    this.loc = { corner: gl.getAttribLocation(program, 'corner'), mvp: gl.getUniformLocation(program, 'mvp'), size: gl.getUniformLocation(program, 'size'), solid: gl.getUniformLocation(program, 'solid'), round: gl.getUniformLocation(program, 'round') };
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ext) this.anisotropy = { ext, max: gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number };
    canvas.addEventListener('pointerdown', e => { this.mousePressed = true; this.mouse(e, 'select-start'); this.grab('mouse', this.mouseHit); });
    canvas.addEventListener('pointerup', e => { this.mousePressed = false; this.grabs.delete('mouse'); this.barGrabs.delete('mouse'); this.edgeGrabs.delete('mouse'); this.mouse(e, 'select-end'); this.events.pointer('select', this.mouseHit); });
    canvas.addEventListener('pointermove', e => { this.mouse(e, null); this.dragMouse(e); });
    canvas.addEventListener('wheel', e => this.events.scroll(-Math.sign(e.deltaY) * 3), { passive: true });
    // Outside the headset the window's frames drive drawing. In immersive mode the Quest stops
    // them, and only the session's frames run (see frame()).
    const desktop = () => { if (!this.session) { this.events.frame(); this.drawDesktop(); } requestAnimationFrame(desktop); };
    requestAnimationFrame(desktop);
  }

  get immersive(): boolean { return this.session !== null; }
  /** Edge currently hovered by the pointer, or null when no resizable edge is under the pointer. */
  get hoveredEdge(): { surface: string; edge: EdgeDir } | null { return this.currentEdgeHover; }
  /** Surface currently being edge-resized and the grabbed edge, or null. */
  get activeEdgeGrab(): { surface: string; edge: EdgeDir } | null {
    for (const e of this.edgeGrabs.values()) return { surface: e.surface, edge: e.edge };
    return null;
  }
  /** Whether the current XR session supports the system keyboard; null when not in XR. */
  get sessionKeyboardSupported(): boolean | null {
    if (!this.session) return null;
    const s = this.session as { isSystemKeyboardSupported?: boolean };
    return typeof s.isSystemKeyboardSupported === 'boolean' ? s.isSystemKeyboardSupported : null;
  }

  set(id: string, canvas: HTMLCanvasElement, width: number, at: Mat): void {
    const existing = this.surfaces.get(id);
    if (existing) { existing.canvas = canvas; existing.width = width; existing.pose = at; existing.dirty = true; return; }
    this.surfaces.set(id, { canvas, width, pose: at, dirty: true, texture: null });
  }

  remove(id: string): void {
    const s = this.surfaces.get(id);
    if (s?.texture) this.gl.deleteTexture(s.texture);
    this.surfaces.delete(id);
  }

  /** Where a point of a surface is in the room, for tests that aim an emulated controller. */
  worldPoint(id: string, x: number, y: number): [number, number, number] | null {
    const s = this.surfaces.get(id);
    if (!s) return null;
    const h = s.width * s.canvas.height / s.canvas.width;
    return apply(multiply(this.anchor, s.pose), [(x - 0.5) * s.width, (0.5 - y) * h, 0], 1);
  }

  async enter(onEnd: () => void): Promise<void> {
    const xr = navigator.xr;
    if (!xr) throw new Error('This browser has no WebXR.');
    const session = await xr.requestSession('immersive-ar', { optionalFeatures: ['hand-tracking'] });
    let space: XRReferenceSpace;
    try {
      await this.gl.makeXRCompatible();
      session.updateRenderState({ baseLayer: new XRWebGLLayer(session, this.gl, { alpha: true, antialias: true }) });
      space = await session.requestReferenceSpace('local');
    } catch (error) {
      // A session that cannot draw is ended, not left running behind the flat page.
      await session.end().catch(() => undefined);
      throw error;
    }
    space.addEventListener('reset', () => { this.needsAnchor = true; });
    this.session = session;
    this.space = space;
    this.needsAnchor = true;
    session.addEventListener('selectstart', e => {
      this.pressing.add(e.inputSource);
      const hit = this.rays.get(e.inputSource)?.hit ?? null;
      // A short tap of vibration says the press landed on something.
      if (hit && this.events.target(hit)) pulse(e.inputSource);
      this.grab(e.inputSource, hit);
      this.events.pointer('select-start', hit);
    });
    session.addEventListener('selectend', e => { this.pressing.delete(e.inputSource); this.grabs.delete(e.inputSource); this.barGrabs.delete(e.inputSource); this.edgeGrabs.delete(e.inputSource); this.events.pointer('select-end', this.rays.get(e.inputSource)?.hit ?? null); });
    session.addEventListener('select', e => this.events.pointer('select', this.rays.get(e.inputSource)?.hit ?? null));
    session.addEventListener('squeezestart', () => this.events.pointer('squeeze-start', null));
    session.addEventListener('squeezeend', () => this.events.pointer('squeeze-end', null));
    session.addEventListener('visibilitychange', () => { this.events.visibilityChange?.(session.visibilityState); });
    session.addEventListener('end', () => { this.session = null; this.space = null; this.rays.clear(); this.pressing.clear(); this.buttonDown.clear(); this.grabs.clear(); this.barGrabs.clear(); this.edgeGrabs.clear(); this.joints = []; onEnd(); });
    session.requestAnimationFrame((t, frame) => this.frame(t, frame));
  }

  /** Leaves mixed reality, back to the flat page. */
  async exit(): Promise<void> { await this.session?.end(); }

  /** Puts the shelf back around where the owner now sits and faces. */
  recenter(): void { this.needsAnchor = true; if (!this.session) this.anchor = pose(0, 0, 0); }

  private frame(t: number, frame: XRFrame): void {
    const session = frame.session, space = this.space;
    if (!space) return;
    session.requestAnimationFrame((t, f) => this.frame(t, f));
    const viewerPose = frame.getViewerPose(space);
    if (!viewerPose) return;
    this.viewer = viewerPose.transform.matrix as Mat;
    if (this.needsAnchor) {
      const m = this.viewer;
      // Keep only the heading of the head's pose, so the shelf stays upright.
      this.anchor = pose(m[12] as number, m[13] as number, m[14] as number, Math.atan2(m[8] as number, m[10] as number));
      this.needsAnchor = false;
    }
    this.events.frame();
    const dt = this.lastFrame ? Math.min(0.1, (t - this.lastFrame) / 1000) : 0;
    this.lastFrame = t;
    this.rays.clear();
    this.joints = [];
    for (const source of session.inputSources) {
      if (source.hand) {
        for (const joint of source.hand.values()) {
          const jp = frame.getJointPose?.(joint, space);
          if (jp) this.joints.push(apply(jp.transform.matrix as Mat, [0, 0, 0], 1));
        }
      }
      const p = frame.getPose(source.targetRaySpace, space);
      if (!p) continue;
      const m = p.transform.matrix as Mat;
      const origin = apply(m, [0, 0, 0], 1), dir = apply(m, [0, 0, -1], 0);
      const hit = this.cast(origin, dir);
      this.rays.set(source, { origin, end: hit ? hit.point : [origin[0] + dir[0] * 2, origin[1] + dir[1] * 2, origin[2] + dir[2] * 2], hit: hit?.hit ?? null });
      // Thumbstick up scrolls back, faster the further it is pushed; a small dead zone stops drift.
      const stick = source.gamepad?.axes[3] ?? 0;
      if (Math.abs(stick) > STICK_DEAD) this.events.scroll(-Math.sign(stick) * (Math.abs(stick) - STICK_DEAD) / (1 - STICK_DEAD) * STICK_ROWS_PER_S * dt);
      const grab = this.grabs.get(source);
      if (grab) this.follow(source, grab, origin, dir);
      const bar = this.barGrabs.get(source);
      if (bar) this.followBar(source, bar, origin, dir);
      const edgeGrab = this.edgeGrabs.get(source);
      if (edgeGrab) this.followEdge(source, edgeGrab, origin, dir);
      // Update hover state: last controller with an edge hit wins.
      if (!edgeGrab && hit?.hit && this.events.edgeResize(hit.hit.surface)) {
        const e = this.edgeOf(hit.hit);
        if (e) this.currentEdgeHover = { surface: hit.hit.surface, edge: e };
        else if (this.currentEdgeHover?.surface === hit.hit.surface) this.currentEdgeHover = null;
      } else if (!edgeGrab && this.currentEdgeHover && !this.edgeGrabs.size) {
        this.currentEdgeHover = null;
      }
      // A/X (the lower face button) held is talk, like holding the Talk button.
      const down = source.gamepad?.buttons[4]?.pressed === true;
      if (down && !this.buttonDown.has(source)) { this.buttonDown.add(source); this.events.pointer('button-start', null); }
      if (!down && this.buttonDown.delete(source)) this.events.pointer('button-end', null);
    }
    const layer = session.renderState.baseLayer as XRWebGLLayer;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    for (const view of viewerPose.views) {
      const vp = layer.getViewport(view);
      if (!vp) continue;
      gl.viewport(vp.x, vp.y, vp.width, vp.height);
      this.draw(multiply(view.projectionMatrix as Mat, view.transform.inverse.matrix as Mat));
    }
  }

  private drawDesktop(): void {
    const gl = this.gl, c = this.canvas;
    const w = c.clientWidth * devicePixelRatio, h = c.clientHeight * devicePixelRatio;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, c.width, c.height);
    // Outside the headset the page's own backdrop stands in for the room.
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const view = invertRigid(pose(...DESKTOP_EYE));
    this.draw(multiply(perspective(1.45, c.width / Math.max(1, c.height), 0.05, 20), view));
  }

  private draw(viewProjection: Mat): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.enableVertexAttribArray(this.loc.corner);
    gl.vertexAttribPointer(this.loc.corner, 2, gl.FLOAT, false, 0, 0);
    gl.uniform4f(this.loc.solid, 0, 0, 0, 0);
    gl.uniform1f(this.loc.round, 1);
    for (const s of this.surfaces.values()) {
      this.upload(s);
      gl.bindTexture(gl.TEXTURE_2D, s.texture);
      gl.uniformMatrix4fv(this.loc.mvp, false, multiply(viewProjection, multiply(this.anchor, s.pose)));
      gl.uniform2f(this.loc.size, s.width, s.width * s.canvas.height / s.canvas.width);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    // What each pointer is over: a highlight that brightens while it is pressed.
    gl.uniform1f(this.loc.round, 0);
    const over: { hit: Hit; pressed: boolean }[] = [];
    for (const [source, ray] of this.rays) if (ray.hit) over.push({ hit: ray.hit, pressed: this.pressing.has(source) });
    if (!this.session && this.mouseHit) over.push({ hit: this.mouseHit, pressed: this.mousePressed });
    for (const { hit, pressed } of over) {
      const s = this.surfaces.get(hit.surface), r = this.events.target(hit);
      if (!s || !r) continue;
      const h = s.width * s.canvas.height / s.canvas.width;
      const cx = ((r.x + r.w / 2) / s.canvas.width - 0.5) * s.width, cy = (0.5 - (r.y + r.h / 2) / s.canvas.height) * h;
      const a = pressed ? 0.42 : 0.2;
      gl.uniform4f(this.loc.solid, 0.42 * a, 0.71 * a, 1 * a, a);
      gl.uniformMatrix4fv(this.loc.mvp, false, multiply(viewProjection, multiply(multiply(this.anchor, s.pose), pose(cx, cy, 0.002))));
      gl.uniform2f(this.loc.size, r.w / s.canvas.width * s.width, r.h / s.canvas.height * h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.uniform1f(this.loc.round, 1);
    // Each ray as a dotted line to where it points, its end a larger dot; tracked hands as joints.
    const dot = (at: [number, number, number], size: number, r: number, g: number, b: number) => {
      gl.uniform4f(this.loc.solid, r, g, b, 1);
      gl.uniformMatrix4fv(this.loc.mvp, false, multiply(viewProjection, pose(...at)));
      gl.uniform2f(this.loc.size, size, size);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    for (const ray of this.rays.values()) {
      const [ox, oy, oz] = ray.origin, [ex, ey, ez] = ray.end;
      const length = Math.hypot(ex - ox, ey - oy, ez - oz), steps = Math.floor(length / 0.05);
      for (let i = 1; i < steps; i += 1) { const t = i / steps; dot([ox + (ex - ox) * t, oy + (ey - oy) * t, oz + (ez - oz) * t], 0.004, 0.8, 0.86, 0.95); }
      dot(ray.end, 0.016, ray.hit ? 0.42 : 0.9, ray.hit ? 0.71 : 0.9, 1);
    }
    for (const j of this.joints) dot(j, 0.01, 0.86, 0.9, 0.95);
  }

  private upload(s: Surface): void {
    const gl = this.gl;
    if (!s.texture) s.texture = gl.createTexture();
    if (!s.dirty) return;
    gl.bindTexture(gl.TEXTURE_2D, s.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, s.canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.anisotropy) gl.texParameterf(gl.TEXTURE_2D, this.anisotropy.ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, this.anisotropy.max));
    s.dirty = false;
  }

  /** The nearest surface a ray meets, and where on its canvas. */
  private cast(origin: [number, number, number], dir: [number, number, number]): { hit: Hit; point: [number, number, number] } | null {
    let best: { hit: Hit; point: [number, number, number]; t: number } | null = null;
    for (const [id, s] of this.surfaces) {
      const world = multiply(this.anchor, s.pose), local = invertRigid(world);
      const o = apply(local, origin, 1), d = apply(local, dir, 0);
      if (Math.abs(d[2]) < 1e-6) continue;
      const t = -o[2] / d[2];
      if (t <= 0 || (best && t >= best.t)) continue;
      const h = s.width * s.canvas.height / s.canvas.width;
      const lx = o[0] + d[0] * t, ly = o[1] + d[1] * t;
      if (Math.abs(lx) > s.width / 2 || Math.abs(ly) > h / 2) continue;
      best = { t, point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t], hit: { surface: id, x: (lx / s.width + 0.5) * s.canvas.width, y: (0.5 - ly / h) * s.canvas.height } };
    }
    return best ? { hit: best.hit, point: best.point } : null;
  }

  /** Starts a scroll grab (draggable surface), group-bar grab, or edge-resize grab. */
  private grab(by: XRInputSource | 'mouse', hit: Hit | null): void {
    if (!hit) return;
    if (this.events.groupBar(hit.surface)) {
      // Record the bar centre in anchor-local space for azimuth/height tracking.
      const s = this.surfaces.get(hit.surface);
      if (s) {
        const toLocal = invertRigid(this.anchor);
        const lp = apply(toLocal, apply(multiply(this.anchor, s.pose), [0, 0, 0], 1), 1);
        // Cylinder radius = XZ distance from anchor origin to bar centre.
        const radius = Math.sqrt(lp[0] * lp[0] + lp[2] * lp[2]);
        this.barGrabs.set(by, { surface: hit.surface, radius });
        this.events.groupBarStart(hit.surface, [lp[0], lp[1], lp[2]]);
      }
      return;
    }
    // Edge resize: a hit in the border strip of a resizable panel starts an edge grab.
    if (this.events.edgeResize(hit.surface)) {
      const edge = this.edgeOf(hit);
      if (edge) {
        const s = this.surfaces.get(hit.surface);
        if (s) {
          const initDist = this.edgeInitDist(s, edge);
          if (initDist > 0) {
            this.edgeGrabs.set(by, { surface: hit.surface, edge, initDist });
            this.events.edgeStart(hit.surface);
            return;
          }
        }
        return; // consume the event even if initDist failed
      }
    }
    if (this.events.draggable(hit.surface) && !this.events.target(hit)) this.grabs.set(by, { surface: hit.surface, y: hit.y });
  }

  /** Returns which edge the hit lands in, or null for the interior. */
  private edgeOf(hit: Hit): EdgeDir | null {
    const s = this.surfaces.get(hit.surface);
    if (!s) return null;
    const nx = hit.x / s.canvas.width, ny = hit.y / s.canvas.height;
    if (nx < EDGE_FRAC) return 'left';
    if (nx > 1 - EDGE_FRAC) return 'right';
    if (ny < EDGE_FRAC) return 'top';
    if (ny > 1 - EDGE_FRAC) return 'bottom';
    return null;
  }

  /**
   * Distance from the head (anchor origin) to the centre of the given edge, in anchor-local metres.
   * Used as the reference distance for scaling: ratio = newDist / initDist.
   */
  private edgeInitDist(s: Surface, edge: EdgeDir): number {
    const h = s.width * s.canvas.height / s.canvas.width;
    // Local offset of edge centre from surface centre (surface-local XY; Z=0)
    const lx = edge === 'right' ? s.width / 2 : edge === 'left' ? -s.width / 2 : 0;
    const ly = edge === 'top' ? h / 2 : edge === 'bottom' ? -h / 2 : 0;
    // Transform from surface-local to anchor-local using pose columns (rigid body).
    const ax = (s.pose[0] ?? 0) * lx + (s.pose[4] ?? 0) * ly + (s.pose[12] ?? 0);
    const ay = (s.pose[1] ?? 0) * lx + (s.pose[5] ?? 0) * ly + (s.pose[13] ?? 0);
    const az = (s.pose[2] ?? 0) * lx + (s.pose[6] ?? 0) * ly + (s.pose[14] ?? 0);
    return Math.sqrt(ax * ax + ay * ay + az * az);
  }

  /** Moves a grab to where its ray now meets the grabbed surface's plane, even past its edge. */
  private follow(by: XRInputSource | 'mouse', grab: { surface: string; y: number }, origin: [number, number, number], dir: [number, number, number]): void {
    const s = this.surfaces.get(grab.surface);
    if (!s) { this.grabs.delete(by); return; }
    const local = invertRigid(multiply(this.anchor, s.pose));
    const o = apply(local, origin, 1), d = apply(local, dir, 0);
    if (Math.abs(d[2]) < 1e-6) return;
    const t = -o[2] / d[2];
    if (t <= 0) return;
    const h = s.width * s.canvas.height / s.canvas.width;
    const y = (0.5 - (o[1] + d[1] * t) / h) * s.canvas.height;
    if (y !== grab.y) { this.events.drag(grab.surface, y - grab.y); grab.y = y; }
  }

  /**
   * Moves a bar grab: intersects the ray with the cylinder at bar.radius in anchor-local space
   * and fires groupMove so main.ts can read azimuth + height and reposition the group.
   */
  private followBar(by: XRInputSource | 'mouse', bar: { surface: string; radius: number }, origin: [number, number, number], dir: [number, number, number]): void {
    const toLocal = invertRigid(this.anchor);
    const o = apply(toLocal, origin, 1), d = apply(toLocal, dir, 0);
    // Cylinder intersection (XZ plane): (ox+t·dx)²+(oz+t·dz)²=r²
    const A = d[0] * d[0] + d[2] * d[2];
    if (A < 1e-9) return; // ray is vertical — no azimuth change
    const B = 2 * (o[0] * d[0] + o[2] * d[2]);
    const C = o[0] * o[0] + o[2] * o[2] - bar.radius * bar.radius;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return; // ray misses the cylinder
    let t = (-B - Math.sqrt(disc)) / (2 * A); // near root
    if (t <= 0) t = (-B + Math.sqrt(disc)) / (2 * A); // far root
    if (t <= 0) { this.barGrabs.delete(by); return; }
    const pos: [number, number, number] = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    this.events.groupMove(bar.surface, pos);
  }

  /**
   * Moves an edge grab: intersects the ray with the surface plane in anchor-local space,
   * measures the distance from the origin to the hit, and reports the ratio to main.ts.
   */
  private followEdge(by: XRInputSource | 'mouse', edgeGrab: { surface: string; initDist: number }, origin: [number, number, number], dir: [number, number, number]): void {
    const s = this.surfaces.get(edgeGrab.surface);
    if (!s) { this.edgeGrabs.delete(by); return; }
    // Convert ray to anchor-local space.
    const toLocal = invertRigid(this.anchor);
    const o = apply(toLocal, origin, 1), d = apply(toLocal, dir, 0);
    // Surface plane normal and centre in anchor-local: col 2 and col 3 of pose.
    const nx = s.pose[8] ?? 0, ny = s.pose[9] ?? 0, nz = s.pose[10] ?? 0;
    const cx = s.pose[12] ?? 0, cy = s.pose[13] ?? 0, cz = s.pose[14] ?? 0;
    const denom = d[0] * nx + d[1] * ny + d[2] * nz;
    if (Math.abs(denom) < 1e-6) return;
    const t = ((cx - o[0]) * nx + (cy - o[1]) * ny + (cz - o[2]) * nz) / denom;
    if (t <= 0) return;
    const px = o[0] + d[0] * t, py = o[1] + d[1] * t, pz = o[2] + d[2] * t;
    const newDist = Math.sqrt(px * px + py * py + pz * pz);
    if (newDist <= 0) return;
    this.events.edgeMove(edgeGrab.surface, newDist / edgeGrab.initDist);
  }

  private dragMouse(e: PointerEvent): void {
    const grab = this.grabs.get('mouse');
    if (grab && !this.session) { this.follow('mouse', grab, DESKTOP_EYE, this.mouseRay(e)); return; }
    const bar = this.barGrabs.get('mouse');
    if (bar && !this.session) { this.followBar('mouse', bar, DESKTOP_EYE, this.mouseRay(e)); return; }
    const edgeGrab = this.edgeGrabs.get('mouse');
    if (edgeGrab && !this.session) this.followEdge('mouse', edgeGrab, DESKTOP_EYE, this.mouseRay(e));
  }

  private mouseRay(e: PointerEvent): [number, number, number] {
    const r = this.canvas.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1, ny = 1 - ((e.clientY - r.top) / r.height) * 2;
    const t = Math.tan(1.45 / 2), aspect = r.width / Math.max(1, r.height);
    return [nx * t * aspect, ny * t, -1];
  }

  private mouse(e: PointerEvent, event: Pointer | null): void {
    if (this.session) return;
    this.mouseHit = this.cast(DESKTOP_EYE, this.mouseRay(e))?.hit ?? null;
    this.canvas.style.cursor = this.mouseHit ? 'pointer' : 'default';
    // Update edge hover state for desktop/mouse.
    if (this.mouseHit && this.events.edgeResize(this.mouseHit.surface)) {
      const e2 = this.edgeOf(this.mouseHit);
      this.currentEdgeHover = e2 ? { surface: this.mouseHit.surface, edge: e2 } : null;
    } else {
      this.currentEdgeHover = null;
    }
    if (event) this.events.pointer(event, this.mouseHit);
  }
}

/** A short vibration on a controller that has a motor; hands and others are left alone. */
function pulse(source: XRInputSource): void {
  const actuator = (source.gamepad as (Gamepad & { hapticActuators?: { pulse?(value: number, ms: number): Promise<boolean> }[] }) | undefined)?.hapticActuators?.[0];
  void actuator?.pulse?.(0.35, 25);
}
