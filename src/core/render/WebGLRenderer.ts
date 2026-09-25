import type { Geometry } from "./geometry.ts"
import { RendererError, type TrajectoryRenderer, type ViewState } from "./Renderer.ts"

/**
 * Bulk trajectory layer on the GPU.
 *
 * Every segment is two vertices in one `gl.LINES` draw call, so the cost of a
 * frame is independent of how many trajectories are on screen — a million
 * segments and a thousand cost the same single call. The vertex shader applies
 * the scales, which is why `ViewState` changes (zoom, resize, row count) never
 * touch the buffers.
 *
 * This is the structural replacement for one `<motion.line>` per link: that
 * approach paid a DOM node, a style recalculation and a MotionValue
 * subscription per segment, which is what put a hard ceiling around a couple of
 * thousand visible lines.
 */

const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 aPosition;   // x = age|year, y = state id
in vec4 aColor;

uniform vec2  uXDomain;    // [min, max] in data units
uniform vec2  uResolution; // device pixels
uniform float uRowCount;
uniform float uMarginY;    // device pixels
uniform float uOpacity;
uniform float uFade;       // 0 = density field, >0 = flatten toward uBackground
uniform vec3  uBackground;
uniform vec2  uOffset;     // device pixels, for faking spine thickness
// stateId -> row, one texel per state. A reorder rewrites this and nothing else.
uniform sampler2D uRows;

out vec4 vColor;

float rowOf(float stateId) {
  return texelFetch(uRows, ivec2(int(stateId), 0), 0).r;
}

void main() {
  float span = max(uXDomain.y - uXDomain.x, 1e-6);
  float px = (aPosition.x - uXDomain.x) / span * uResolution.x;

  float usable = max(uResolution.y - 2.0 * uMarginY, 1.0);
  float rowHeight = usable / max(uRowCount, 1.0);
  float py = uMarginY + (rowOf(aPosition.y) + 0.5) * rowHeight;

  px += uOffset.x;
  py += uOffset.y;

  gl_Position = vec4(
    px / uResolution.x * 2.0 - 1.0,
    1.0 - py / uResolution.y * 2.0,
    0.0,
    1.0
  );

  // The caller passes uOpacity = 1 whenever uFade > 0, so a faded layer is
  // opaque and overlapping lines land on the same value instead of stacking.
  vColor = vec4(mix(aColor.rgb, uBackground, uFade), aColor.a * uOpacity);
}`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vec4(vColor.rgb * vColor.a, vColor.a); }`

/**
 * Picking pass. Identical geometry, but each segment is painted in a colour that
 * *is* its index — so reading one pixel back names the segment under the cursor.
 *
 * `gl_VertexID / 2` recovers the segment from the vertex, which means the id
 * needs no attribute and no extra buffer: picking costs zero additional memory
 * over what the display pass already uploaded.
 */
const PICK_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 aPosition;

uniform vec2  uXDomain;
uniform vec2  uResolution;
uniform float uRowCount;
uniform float uMarginY;
uniform sampler2D uRows;

flat out uint vId;

void main() {
  float span = max(uXDomain.y - uXDomain.x, 1e-6);
  float px = (aPosition.x - uXDomain.x) / span * uResolution.x;

  float usable = max(uResolution.y - 2.0 * uMarginY, 1.0);
  float rowHeight = usable / max(uRowCount, 1.0);
  float py = uMarginY + (texelFetch(uRows, ivec2(int(aPosition.y), 0), 0).r + 0.5) * rowHeight;

  gl_Position = vec4(
    px / uResolution.x * 2.0 - 1.0,
    1.0 - py / uResolution.y * 2.0,
    0.0,
    1.0
  );

  // +1 so that 0 stays reserved for "nothing here".
  vId = uint(gl_VertexID / 2) + 1u;
}`

const PICK_FRAGMENT_SHADER = `#version 300 es
precision highp float;
flat in uint vId;
out vec4 outColor;
void main() {
  outColor = vec4(
    float(vId & 255u) / 255.0,
    float((vId >> 8) & 255u) / 255.0,
    float((vId >> 16) & 255u) / 255.0,
    1.0
  );
}`

interface Uniforms {
  xDomain: WebGLUniformLocation | null
  resolution: WebGLUniformLocation | null
  rowCount: WebGLUniformLocation | null
  marginY: WebGLUniformLocation | null
  rows: WebGLUniformLocation | null
  opacity: WebGLUniformLocation | null
  fade: WebGLUniformLocation | null
  background: WebGLUniformLocation | null
  offset: WebGLUniformLocation | null
}

/**
 * Sub-pixel offsets used to fake a thick line.
 *
 * WebGL guarantees only 1px `gl.LINES`, so a medoid spine is drawn several times
 * at small offsets. That is fine precisely because the spine layer is tiny — a
 * few hundred segments — whereas doing the same to the bulk layer would multiply
 * the expensive draw. The bulk layer stays hairline by design: that is what makes
 * the density readable.
 */
const SPINE_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.6, 0],
  [-0.6, 0],
  [0, 0.6],
  [0, -0.6],
  [0.45, 0.45],
  [-0.45, -0.45],
  [0.45, -0.45],
  [-0.45, 0.45],
]

export class WebGLRenderer implements TrajectoryRenderer {
  readonly kind = "webgl2" as const

  private readonly gl: WebGL2RenderingContext
  private readonly program: WebGLProgram
  private readonly pickProgram: WebGLProgram
  private readonly vao: WebGLVertexArrayObject
  private readonly pickVao: WebGLVertexArrayObject
  private readonly positionBuffer: WebGLBuffer
  private readonly colorBuffer: WebGLBuffer
  private readonly uniforms: Uniforms
  private readonly pickUniforms: Omit<Uniforms, "opacity" | "offset" | "fade" | "background">
  private rowTexture: WebGLTexture | null = null
  private rowCount = 0

  private pickFramebuffer: WebGLFramebuffer | null = null
  private pickTexture: WebGLTexture | null = null
  private pickSize = { width: 0, height: 0 }
  private readonly pickPixels = new Uint8Array(4 * 41 * 41)

  private readonly overlayVao: WebGLVertexArrayObject
  private readonly overlayPositionBuffer: WebGLBuffer
  private readonly overlayColorBuffer: WebGLBuffer
  private overlayVertexCount = 0

  private vertexCount = 0
  private dpr = 1

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      alpha: true,
      // The chart is redrawn from scratch each frame; keeping the buffer is
      // wasted bandwidth at these vertex counts.
      preserveDrawingBuffer: false,
      desynchronized: true,
    })
    if (gl === null) throw new RendererError("WebGL2 is not available")
    this.gl = gl

    this.program = linkProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER)
    this.uniforms = {
      xDomain: gl.getUniformLocation(this.program, "uXDomain"),
      resolution: gl.getUniformLocation(this.program, "uResolution"),
      rowCount: gl.getUniformLocation(this.program, "uRowCount"),
      marginY: gl.getUniformLocation(this.program, "uMarginY"),
      rows: gl.getUniformLocation(this.program, "uRows"),
      opacity: gl.getUniformLocation(this.program, "uOpacity"),
      fade: gl.getUniformLocation(this.program, "uFade"),
      background: gl.getUniformLocation(this.program, "uBackground"),
      offset: gl.getUniformLocation(this.program, "uOffset"),
    }

    this.pickProgram = linkProgram(gl, PICK_VERTEX_SHADER, PICK_FRAGMENT_SHADER)
    this.pickUniforms = {
      xDomain: gl.getUniformLocation(this.pickProgram, "uXDomain"),
      resolution: gl.getUniformLocation(this.pickProgram, "uResolution"),
      rowCount: gl.getUniformLocation(this.pickProgram, "uRowCount"),
      marginY: gl.getUniformLocation(this.pickProgram, "uMarginY"),
      rows: gl.getUniformLocation(this.pickProgram, "uRows"),
    }

    const vao = gl.createVertexArray()
    const pickVao = gl.createVertexArray()
    const overlayVao = gl.createVertexArray()
    const positionBuffer = gl.createBuffer()
    const colorBuffer = gl.createBuffer()
    const overlayPositionBuffer = gl.createBuffer()
    const overlayColorBuffer = gl.createBuffer()
    if (
      vao === null ||
      pickVao === null ||
      overlayVao === null ||
      positionBuffer === null ||
      colorBuffer === null ||
      overlayPositionBuffer === null ||
      overlayColorBuffer === null
    ) {
      throw new RendererError("Could not allocate WebGL buffers")
    }
    this.vao = vao
    this.pickVao = pickVao
    this.overlayVao = overlayVao
    this.positionBuffer = positionBuffer
    this.colorBuffer = colorBuffer
    this.overlayPositionBuffer = overlayPositionBuffer
    this.overlayColorBuffer = overlayColorBuffer

    const positionLocation = gl.getAttribLocation(this.program, "aPosition")
    const colorLocation = gl.getAttribLocation(this.program, "aColor")

    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.enableVertexAttribArray(positionLocation)
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0)

    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer)
    gl.enableVertexAttribArray(colorLocation)
    gl.vertexAttribPointer(colorLocation, 4, gl.UNSIGNED_BYTE, true, 0, 0)

    gl.bindVertexArray(overlayVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, overlayPositionBuffer)
    gl.enableVertexAttribArray(positionLocation)
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, overlayColorBuffer)
    gl.enableVertexAttribArray(colorLocation)
    gl.vertexAttribPointer(colorLocation, 4, gl.UNSIGNED_BYTE, true, 0, 0)

    // The pick pass reads positions only; no colour attribute is bound.
    const pickPositionLocation = gl.getAttribLocation(this.pickProgram, "aPosition")
    gl.bindVertexArray(pickVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.enableVertexAttribArray(pickPositionLocation)
    gl.vertexAttribPointer(pickPositionLocation, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)

    // Premultiplied alpha: the fragment shader already multiplies, which keeps
    // heavy overplotting from washing out to white.
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  resize(width: number, height: number, dpr: number): void {
    this.dpr = dpr
    const w = Math.max(1, Math.round(width * dpr))
    const h = Math.max(1, Math.round(height * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    this.gl.viewport(0, 0, w, h)
  }

  /**
   * Uploads the state→row lookup as a one-row R32F texture.
   *
   * A texture rather than a uniform array because the array's length has to be a
   * compile-time constant in GLSL, which would put an arbitrary ceiling on the
   * state vocabulary; a texture has none worth worrying about. It is a few
   * hundred bytes either way.
   */
  setRowLookup(rows: Float32Array): void {
    const { gl } = this

    if (this.rowTexture === null) {
      this.rowTexture = gl.createTexture()
      if (this.rowTexture === null) throw new RendererError("Could not create row texture")
      gl.bindTexture(gl.TEXTURE_2D, this.rowTexture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    }

    gl.bindTexture(gl.TEXTURE_2D, this.rowTexture)
    if (rows.length !== this.rowCount) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, rows.length, 1, 0, gl.RED, gl.FLOAT, rows)
      this.rowCount = rows.length
    } else {
      // The common case during an animation: same vocabulary, new positions.
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, rows.length, 1, gl.RED, gl.FLOAT, rows)
    }
  }

  private bindRows(location: WebGLUniformLocation | null): void {
    const { gl } = this
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.rowTexture)
    gl.uniform1i(location, 0)
  }

  setGeometry(geometry: Geometry | null): void {
    this.vertexCount = this.upload(geometry, this.positionBuffer, this.colorBuffer)
  }

  setOverlayGeometry(geometry: Geometry | null): void {
    this.overlayVertexCount = this.upload(
      geometry,
      this.overlayPositionBuffer,
      this.overlayColorBuffer,
    )
  }

  private upload(
    geometry: Geometry | null,
    positions: WebGLBuffer,
    colors: WebGLBuffer,
  ): number {
    const { gl } = this
    if (geometry === null || geometry.segmentCount === 0) return 0

    gl.bindBuffer(gl.ARRAY_BUFFER, positions)
    gl.bufferData(gl.ARRAY_BUFFER, geometry.positions, gl.STATIC_DRAW)

    gl.bindBuffer(gl.ARRAY_BUFFER, colors)
    gl.bufferData(gl.ARRAY_BUFFER, geometry.colors, gl.STATIC_DRAW)

    return geometry.segmentCount * 2
  }

  draw(view: ViewState): void {
    const { gl, uniforms } = this
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.useProgram(this.program)
    gl.uniform2f(uniforms.xDomain, view.xDomain[0], view.xDomain[1])
    gl.uniform2f(uniforms.resolution, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.uniform1f(uniforms.rowCount, view.rowCount)
    gl.uniform1f(uniforms.marginY, view.marginY * this.dpr)
    this.bindRows(uniforms.rows)

    // Bulk layer: one draw, hairlines, low alpha — or, under an overlay, one
    // opaque draw in a colour already mixed toward the background.
    const fading = view.bulkFade > 0
    if (this.vertexCount > 0 && (fading || view.opacity > 0)) {
      gl.bindVertexArray(this.vao)
      gl.uniform1f(uniforms.opacity, fading ? 1 : view.opacity)
      gl.uniform1f(uniforms.fade, view.bulkFade)
      gl.uniform3f(uniforms.background, view.background[0], view.background[1], view.background[2])
      gl.uniform2f(uniforms.offset, 0, 0)
      gl.drawArrays(gl.LINES, 0, this.vertexCount)
    }

    // Spine layer: repeated at sub-pixel offsets to reach the requested width.
    if (this.overlayVertexCount > 0 && view.overlayOpacity > 0) {
      gl.bindVertexArray(this.overlayVao)
      gl.uniform1f(uniforms.opacity, view.overlayOpacity)
      // The overlay is the thing being looked at; it never fades.
      gl.uniform1f(uniforms.fade, 0)

      const passes = Math.max(
        1,
        Math.min(SPINE_OFFSETS.length, Math.round(view.overlayWidth * this.dpr)),
      )
      for (let i = 0; i < passes; i++) {
        const [dx, dy] = SPINE_OFFSETS[i] as readonly [number, number]
        gl.uniform2f(uniforms.offset, dx * this.dpr, dy * this.dpr)
        gl.drawArrays(gl.LINES, 0, this.overlayVertexCount)
      }
    }

    gl.bindVertexArray(null)
  }

  /**
   * Reads the segment id straight out of a pick render.
   *
   * The scissor box restricts rasterisation to a small square around the cursor,
   * so the fragment cost is a few hundred pixels regardless of dataset size, and
   * the whole query is one draw plus one `readPixels`. That is O(1) in the number
   * of trajectories — unlike a CPU spatial index, whose buckets get denser
   * exactly when the dataset gets big enough to matter.
   *
   * It is also pixel-exact: it returns what the user can actually see under the
   * cursor, including the topmost line where many overlap.
   */
  pickAt(x: number, y: number, view: ViewState, radius: number): number | null {
    const { gl } = this
    if (this.vertexCount === 0) return null

    const box = Math.max(1, Math.min(20, Math.round(radius)))
    const size = box * 2 + 1

    const px = Math.round(x * this.dpr)
    // readPixels is bottom-up, the pointer is top-down.
    const py = Math.round(gl.drawingBufferHeight - y * this.dpr)

    const x0 = Math.max(0, Math.min(gl.drawingBufferWidth - size, px - box))
    const y0 = Math.max(0, Math.min(gl.drawingBufferHeight - size, py - box))

    this.ensurePickTarget()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFramebuffer)

    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(x0, y0, size, size)
    gl.disable(gl.BLEND)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.useProgram(this.pickProgram)
    gl.bindVertexArray(this.pickVao)
    gl.uniform2f(this.pickUniforms.xDomain, view.xDomain[0], view.xDomain[1])
    gl.uniform2f(this.pickUniforms.resolution, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.uniform1f(this.pickUniforms.rowCount, view.rowCount)
    gl.uniform1f(this.pickUniforms.marginY, view.marginY * this.dpr)
    this.bindRows(this.pickUniforms.rows)
    gl.drawArrays(gl.LINES, 0, this.vertexCount)

    const pixels = this.pickPixels.subarray(0, size * size * 4)
    gl.readPixels(x0, y0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

    gl.bindVertexArray(null)
    gl.disable(gl.SCISSOR_TEST)
    gl.enable(gl.BLEND)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    // Nearest hit to the centre of the box, so a crowded area picks the line the
    // cursor is actually closest to rather than whichever was drawn last.
    const centre = px - x0
    const centreY = py - y0
    let best = -1
    let bestDistance = Infinity

    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        const offset = (row * size + column) * 4
        const id =
          (pixels[offset] as number) |
          ((pixels[offset + 1] as number) << 8) |
          ((pixels[offset + 2] as number) << 16)
        if (id === 0) continue

        const distance = (column - centre) ** 2 + (row - centreY) ** 2
        if (distance < bestDistance) {
          bestDistance = distance
          best = id - 1
        }
      }
    }

    return best === -1 ? null : best
  }

  /** Lazily sized offscreen target, rebuilt only when the canvas changes size. */
  private ensurePickTarget(): void {
    const { gl } = this
    const width = gl.drawingBufferWidth
    const height = gl.drawingBufferHeight
    if (this.pickFramebuffer !== null && this.pickSize.width === width && this.pickSize.height === height) {
      return
    }

    if (this.pickTexture !== null) gl.deleteTexture(this.pickTexture)
    if (this.pickFramebuffer !== null) gl.deleteFramebuffer(this.pickFramebuffer)

    const texture = gl.createTexture()
    const framebuffer = gl.createFramebuffer()
    if (texture === null || framebuffer === null) throw new RendererError("Could not create pick target")

    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    this.pickTexture = texture
    this.pickFramebuffer = framebuffer
    this.pickSize = { width, height }
  }

  dispose(): void {
    const { gl } = this
    gl.deleteBuffer(this.positionBuffer)
    gl.deleteBuffer(this.colorBuffer)
    gl.deleteBuffer(this.overlayPositionBuffer)
    gl.deleteBuffer(this.overlayColorBuffer)
    gl.deleteVertexArray(this.vao)
    gl.deleteVertexArray(this.pickVao)
    gl.deleteVertexArray(this.overlayVao)
    gl.deleteProgram(this.program)
    gl.deleteProgram(this.pickProgram)
    if (this.pickTexture !== null) gl.deleteTexture(this.pickTexture)
    if (this.pickFramebuffer !== null) gl.deleteFramebuffer(this.pickFramebuffer)
    if (this.rowTexture !== null) gl.deleteTexture(this.rowTexture)
  }
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (shader === null) throw new RendererError("Could not create shader")
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new RendererError(`Shader compilation failed: ${log ?? "unknown error"}`)
  }
  return shader
}

function linkProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram()
  if (program === null) throw new RendererError("Could not create program")

  const vertex = compile(gl, gl.VERTEX_SHADER, vs)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fs)
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new RendererError(`Program link failed: ${log ?? "unknown error"}`)
  }
  return program
}
