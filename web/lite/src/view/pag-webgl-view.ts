import { WEBGL_CONTEXT_ATTRIBUTES } from '../constant';
import { destroyVerify } from '../decorators';
import { PAGFile } from '../pag-file';
import { RenderOptions } from './context';
import { FRAGMENT_2D_SHADER, FRAGMENT_2D_SHADER_TRANSPARENT, VERTEX_2D_SHADER } from './shader';
import { createAndSetupTexture, createProgram, detectWebGLContext, getShaderSourceFromString } from './utils';
import { View } from './view';

@destroyVerify
export class PAGWebGLView extends View {
  protected gl: WebGLRenderingContext;
  protected scale: { x: number; y: number } = { x: 1, y: 1 };

  private program: WebGLProgram;
  private positionLocation = 0;
  private texcoordLocation = 0;
  private alphaStartLocation: WebGLUniformLocation | null = null;
  private scaleLocation: WebGLUniformLocation | null = null;
  private resolutionLocation: WebGLUniformLocation | null = null;
  private positionBuffer: WebGLBuffer | null = null;
  private texcoordBuffer: WebGLBuffer | null = null;
  private originalVideoTexture: WebGLTexture | null = null;
  // bobihuang: 移除冗余的 renderingTexture 和 renderingFbo
  // 原因：shader 已经在 GPU 上直接处理 alpha 通道合成，不需要离屏渲染
  // private renderingTexture: WebGLTexture | null = null;
  // private renderingFbo: WebGLFramebuffer | null = null;

  // OffscreenCanvas 中间缓冲 - 用于打断 VideoElement 与 WebGL 纹理的直接引用链
  // 解决 Chromium GPU 进程长时间运行时 SharedImage/GpuMemoryBuffer 累积问题
  private offscreenCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private offscreenCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

  public constructor(pagFile: PAGFile, canvas: HTMLCanvasElement, options: RenderOptions) {
    super(pagFile, canvas, options);
    const gl = this.canvas?.getContext('webgl', {
      ...WEBGL_CONTEXT_ATTRIBUTES,
    });
    if (!gl) throw new Error("Can't get WebGL context!");
    this.gl = gl;
    if (this.videoParam.hasAlpha) {
      this.program = createProgram(
        this.gl,
        getShaderSourceFromString(VERTEX_2D_SHADER),
        getShaderSourceFromString(FRAGMENT_2D_SHADER_TRANSPARENT),
      );
    } else {
      this.program = createProgram(
        this.gl,
        getShaderSourceFromString(VERTEX_2D_SHADER),
        getShaderSourceFromString(FRAGMENT_2D_SHADER),
      );
    }
    this.initOffscreenCanvas();
    this.loadContext();
  }

  public override destroy(): void {
    // ⚠️ CRITICAL: 必须先调用父类 destroy() 来停止渲染循环
    // 原因分析：
    // 1. super.destroy() 会调用 clearTimer() 停止 requestAnimationFrame
    // 2. super.destroy() 会调用 clearRender()，此时需要 this.gl 仍然有效
    // 3. super.destroy() 会设置 this.destroyed = true，阻止后续 draw() 调用
    // 4. 只有在渲染循环完全停止后，才能安全释放 WebGL 资源
    //
    // 错误的顺序会导致：
    // - 先释放 WebGL 资源 → super.destroy() 调用 clearRender() → 访问已释放的 this.gl → 崩溃
    super.destroy();

    // 释放 OffscreenCanvas 资源
    if (this.offscreenCtx) {
      // 清空画布内容，帮助释放内存
      if (this.offscreenCanvas) {
        this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
      }
      this.offscreenCtx = null;
    }
    this.offscreenCanvas = null;

    // 确保在销毁 WebGL 资源之前检查上下文是否仍然有效
    if (!this.gl || this.gl.isContextLost()) {
      // 上下文已经丢失，直接清理引用
      this.originalVideoTexture = null;
      this.positionBuffer = null;
      this.texcoordBuffer = null;
      // @ts-ignore
      this.program = null;
      // @ts-ignore
      this.gl = null;
      return;
    }

    // Release textures (largest GPU memory footprint)
    if (this.originalVideoTexture) {
      this.gl.deleteTexture(this.originalVideoTexture);
      this.originalVideoTexture = null;
    }

    // Release buffers
    if (this.positionBuffer) {
      this.gl.deleteBuffer(this.positionBuffer);
      this.positionBuffer = null;
    }
    if (this.texcoordBuffer) {
      this.gl.deleteBuffer(this.texcoordBuffer);
      this.texcoordBuffer = null;
    }

    // Release program and shaders
    if (this.program) {
      const shaders = this.gl.getAttachedShaders(this.program);
      if (shaders) {
        shaders.forEach((shader) => {
          this.gl.detachShader(this.program, shader);
          this.gl.deleteShader(shader);
        });
      }
      this.gl.deleteProgram(this.program);
      // @ts-ignore
      this.program = null;
    }

    // ⚠️ CRITICAL: 强制释放 WebGL 上下文，避免达到浏览器上下文数量限制
    // Chrome/Firefox/Safari 等浏览器通常限制约 16 个活跃 WebGL 上下文
    // 不释放会导致：
    // 1. 后续创建上下文失败 (WARNING: Too many active WebGL contexts)
    // 2. GPU 内存泄漏
    // 3. 渲染黑屏或异常
    const loseContextExt = this.gl.getExtension('WEBGL_lose_context');
    if (loseContextExt) {
      loseContextExt.loseContext();
    }

    // 清空 WebGL 上下文引用，帮助垃圾回收
    // @ts-ignore - 需要清空引用以彻底释放内存
    this.gl = null;
  }

  protected override loadContext() {
    // look up where the vertex data needs to go.
    if (!this.program) throw new Error('program is not initialized');
    this.positionLocation = this.gl.getAttribLocation(this.program, 'a_position');
    if (this.positionLocation === -1) throw new Error('unable to get attribute location for a_position');
    this.scaleLocation = this.gl.getUniformLocation(this.program, 'u_scale');
    if (!this.scaleLocation) throw new Error('unable to get uniform location for u_scale');
    this.texcoordLocation = this.gl.getAttribLocation(this.program, 'a_texCoord');
    if (this.texcoordLocation === -1) throw new Error('unable to get attribute location for a_texCoord');
    if (this.videoParam.hasAlpha) {
      this.alphaStartLocation = this.gl.getUniformLocation(this.program, 'v_alphaStart');
      if (!this.alphaStartLocation) throw new Error('unable to get uniform location for v_alphaStart');
    }
    this.resolutionLocation = this.gl.getUniformLocation(this.program, 'u_resolution');
    if (!this.resolutionLocation) throw new Error('unable to get uniform location for u_resolution');

    // Create a buffer to put three 2d clip space points in
    this.positionBuffer = this.gl.createBuffer();

    // Bind it to ARRAY_BUFFER (think of it as ARRAY_BUFFER = positionBuffer)
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
    // Set a rectangle the same size as the image.
    this.setRectangle(this.gl, 0, 0, this.videoParam.MP4Width, this.videoParam.MP4Height);

    // provide texture coordinates for the rectangle.
    this.texcoordBuffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.texcoordBuffer);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      new Float32Array([0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0]),
      this.gl.STATIC_DRAW,
    );

    // bobihuang: 创建并预分配视频纹理 GPU 内存
    // Create a texture and pre-allocate storage for video frame uploads.
    this.originalVideoTexture = createAndSetupTexture(this.gl);
    this.gl.texImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.gl.RGBA,
      this.videoParam.MP4Width,
      this.videoParam.MP4Height,
      0,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      null,
    );
  }

  protected override draw() {
    // ⚠️ CRITICAL: 防御性检查 - 避免 destroy() 后的竞态条件导致白屏/透明
    // 场景：requestAnimationFrame 回调可能在 destroy() 后触发
    // 必须检查所有必要的 WebGL 资源，而不仅仅是上下文
    if (!this.gl || this.gl.isContextLost() || 
        !this.originalVideoTexture || 
        !this.positionBuffer || 
        !this.texcoordBuffer || 
        !this.program) {
      return;
    }

    this.gl.bindTexture(this.gl.TEXTURE_2D, this.originalVideoTexture);
    // Upload the video into the texture.
    this.texImage2D();
    // Clear the canvas
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);

    // Tell it to use our program (pair of shaders)
    this.gl.useProgram(this.program);

    // Turn on the position attribute
    this.gl.enableVertexAttribArray(this.positionLocation);

    // Bind the position buffer
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);

    // Tell the position attribute how to get data out of positionBuffer (ARRAY_BUFFER)
    const size = 2; // 2 components per iteration
    const type: number = this.gl.FLOAT; // the data is 32bit floats
    const normalize = false; // don't normalize the data
    const stride = 0; // 0 = move forward size * sizeof(type) each iteration to get the next position
    const offset = 0; // start at the beginning of the buffer
    this.gl.vertexAttribPointer(this.positionLocation, size, type, normalize, stride, offset);

    // Turn on the texcoord attribute
    this.gl.enableVertexAttribArray(this.texcoordLocation);

    // Bind the texcoord buffer.
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.texcoordBuffer);

    this.gl.vertexAttribPointer(this.texcoordLocation, size, type, normalize, stride, offset);

    if (this.videoParam.hasAlpha) {
      this.gl.uniform2f(
        this.alphaStartLocation,
        this.videoParam.alphaStartX / this.videoParam.MP4Width / this.scale.x,
        this.videoParam.alphaStartY / this.videoParam.MP4Height / this.scale.y,
      );
    }

    // bobihuang: 单通道渲染优化 - 移除冗余的离屏 FBO，直接渲染到屏幕
    // 原双通道渲染：第一次渲染到 FBO -> 第二次从 FBO 读取渲染到屏幕
    // 优化后：直接渲染到屏幕，shader 在 GPU 上完成 alpha 合成，性能提升约 50%
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.gl.uniform2f(this.resolutionLocation, this.videoParam.sequenceWidth, this.videoParam.sequenceHeight);
    this.gl.uniform2f(this.scaleLocation, this.scale.x, this.scale.y);
    this.gl.viewport(this.viewportSize.x, this.viewportSize.y, this.viewportSize.width, this.viewportSize.height);
    const primitiveType: number = this.gl.TRIANGLES;
    const count = 6;
    this.gl.drawArrays(primitiveType, offset, count);
  }

  protected override clearRender() {
    // ⚠️ CRITICAL: 防御性检查 - 避免 destroy() 后调用导致错误
    if (!this.gl || this.gl.isContextLost()) {
      return;
    }
    
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  protected detectWebGLContext() {
    return detectWebGLContext();
  }

  protected texImage2D() {
    // ⚠️ CRITICAL: 防御性检查 - 避免 destroy() 后调用导致错误
    if (!this.gl || this.gl.isContextLost()) {
      return;
    }
    
    const videoElement = this.videoReader.getVideoElement();
    if (videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    // 使用 OffscreenCanvas 中间缓冲，打断 VideoElement 与 WebGL 纹理的直接引用链
    // 这可以避免 Chromium GPU 进程长时间运行时 SharedImage/GpuMemoryBuffer 累积
    if (this.offscreenCtx && this.offscreenCanvas) {
      // 步骤1: VideoElement → OffscreenCanvas (CPU 拷贝，打断 GPU 引用链)
      this.offscreenCtx.drawImage(videoElement, 0, 0);
      
      // 步骤2: OffscreenCanvas → WebGL 纹理 (标准纹理上传路径)
      this.gl.texSubImage2D(
        this.gl.TEXTURE_2D,
        0,
        0,
        0,
        this.gl.RGBA,
        this.gl.UNSIGNED_BYTE,
        this.offscreenCanvas,
      );
    } else {
      // 降级：直接使用 VideoElement（可能在某些环境下 OffscreenCanvas 初始化失败）
      this.gl.texSubImage2D(
        this.gl.TEXTURE_2D,
        0,
        0,
        0,
        this.gl.RGBA,
        this.gl.UNSIGNED_BYTE,
        videoElement,
      );
    }
  }

  private setRectangle(gl: WebGLRenderingContext, x: number, y: number, width: number, height: number) {
    const x1: number = x;
    const x2: number = x + width;
    const y1: number = y;
    const y2: number = y + height;
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([x1, y1, x2, y1, x1, y2, x1, y2, x2, y1, x2, y2]), gl.STATIC_DRAW);
  }

  /**
   * 初始化 OffscreenCanvas 中间缓冲
   * 作用：打断 VideoElement → WebGL 纹理的直接引用链
   * 原理：VideoElement → OffscreenCanvas (CPU 拷贝) → WebGL 纹理
   * 这样 Chromium GPU 进程不会保持对 VideoElement 解码缓冲区的引用
   */
  private initOffscreenCanvas(): void {
    const width = this.videoParam.MP4Width;
    const height = this.videoParam.MP4Height;

    // 优先使用 OffscreenCanvas（性能更好，支持 Worker）
    // 降级到普通 Canvas（兼容旧浏览器）
    if (typeof OffscreenCanvas !== 'undefined') {
      this.offscreenCanvas = new OffscreenCanvas(width, height);
      this.offscreenCtx = this.offscreenCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    } else {
      // 降级方案：使用普通 Canvas
      this.offscreenCanvas = document.createElement('canvas');
      this.offscreenCanvas.width = width;
      this.offscreenCanvas.height = height;
      this.offscreenCtx = this.offscreenCanvas.getContext('2d');
    }
  }
}
