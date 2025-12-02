import { Context, RenderOptions } from './context';
import { getWechatNetwork } from './utils';
import { EventName } from '../types';
import { IS_IOS } from '../constant';
import { destroyVerify } from '../decorators';

import type { PAGFile } from '../pag-file';
import { VideoReader } from './video-reader';
import { VideoSequence } from '../base/video-sequence';

declare global {
  interface Window {
    WeixinJSBridge?: any;
  }
}

const IS_WECHAT = navigator && /MicroMessenger/i.test(navigator.userAgent);

export const playVideoElement = async (videoElement: HTMLVideoElement) => {
  if (IS_WECHAT && window.WeixinJSBridge) {
    await getWechatNetwork();
  }
  try {
    await videoElement.play();
  } catch (error: any) {
    throw new Error(error.message);
  }
};

@destroyVerify
export class View extends Context {
  protected videoReader: VideoReader;
  protected currentFrame = -1;
  protected needSeek = false;

  // bobihuang: 内存泄漏修复 - 预绑定 requestAnimationFrame 回调函数
  // 原因：每帧创建新的箭头函数闭包，闭包引用整个 View 实例
  // 修复：绑定为实例方法，复用同一个函数引用
  private readonly boundFlushLoopCallback: FrameRequestCallback;

  public constructor(pagFile: PAGFile, canvas: HTMLCanvasElement, options: RenderOptions) {
    super(pagFile, canvas, options);
    // 在构造函数中绑定，确保 this 指向正确
    this.boundFlushLoopCallback = this.flushLoopCallback.bind(this);
    this.videoReader = this.createVideoReader(this.videoSequence);
  }

  /**
   * 开始播放
   */
  public async play() {
    if (this.playing) return;
    this.playing = true;
    await this.videoReader.start();
    await this.flushLoop();
    if (this.getProgress() === 0) {
      this.eventManager.emit(EventName.onAnimationStart);
    }
    this.eventManager.emit(EventName.onAnimationPlay);
  }
  /**
   * 暂停播放
   */
  public pause() {
    if (!this.playing) return;
    this.videoReader.pause();
    this.clearTimer();
    this.playing = false;
    this.eventManager.emit(EventName.onAnimationPause);
  }
  /**
   * 停止播放
   */
  public stop() {
    this.videoReader.pause();
    this.videoReader.seek(0);
    this.clearRender();
    this.playing = false;
    this.eventManager.emit(EventName.onAnimationCancel);
  }
  /**
   * 销毁播放实例
   */
  public destroy() {
    this.clearTimer();
    this.clearRender();
    this.canvas = null;
    this.videoReader.destroy();

    // bobihuang optimization: reuse VideoSequence.releaseRawData() method
    this.videoSequence?.releaseRawData();

    this.destroyed = true;
  }
  /**
   * 返回当前播放进度位置，取值范围为 0.0 到 1.0。
   */
  public getProgress() {
    return this.currentFrame / this.videoSequence.frameCount;
  }
  /**
   * 设置播放进度位置，取值范围为 0.0 到 1.0。
   */
  public setProgress(progress: number) {
    if (progress < 0 || progress > 1) throw new Error('progress must be between 0.0 and 1.0!');
    const currentFrame = Math.round(progress * this.videoSequence.frameCount);
    if (this.currentFrame !== currentFrame) {
      this.needSeek = true;
      this.currentFrame = currentFrame;
    }
  }
  /**
   * 渲染当前进度画面
   */
  public flush() {
    return this.flushInternal(true);
  }

  protected draw() {}

  protected createVideoReader(videoSequence: VideoSequence) {
    const { videoReader, debugData } = VideoReader.create(videoSequence);
    this.setDebugData(debugData);
    if (!IS_IOS) {
      videoReader.addListener('ended', () => {
        this.repeat();
      });
    }
    return videoReader;
  }

  protected async repeat() {
    // 循环结束
    if (this.repeatCount === 0) {
      this.setProgress(1);
      await this.flushInternal(true);
      this.videoReader.pause();
      this.clearTimer();
      this.playing = false;
      this.eventManager.emit('onAnimationEnd');
      return false;
    }
    // 次数循环
    this.repeatCount -= 1;
    if (IS_IOS) {
      await this.videoReader.seek(0);
    } else {
      this.videoReader.start();
    }
    this.eventManager.emit('onAnimationRepeat');
    return true;
  }

  protected flushLoop() {
    // bobihuang: 先清除旧的 timer，避免竞态条件导致的多次注册
    if (this.renderTimer) {
      window.cancelAnimationFrame(this.renderTimer);
    }

    // bobihuang: 内存泄漏修复 - 使用预绑定的回调函数
    // 原方案：每帧创建新箭头函数 → 170万个闭包对象 → ~200MB 泄漏
    // 修复后：复用同一个函数引用 → 0 额外分配
    this.renderTimer = window.requestAnimationFrame(this.boundFlushLoopCallback);

    if (IS_IOS && this.duration() - this.videoReader.currentTime() <= 1 / this.frameRate()) {
      this.repeat();
    }
    return this.flushInternal(false);
  }

  protected clearTimer() {
    if (this.renderTimer) {
      window.cancelAnimationFrame(this.renderTimer);
      this.renderTimer = null;
    }
  }


  protected async flushInternal(sync: boolean) {
    
    if (this.needSeek) {
      if (sync) {
        await this.videoReader.seek(this.currentFrame / this.frameRate());
      } else {
        this.videoReader.seek(this.currentFrame / this.frameRate());
      }
      this.needSeek = false;
    } else {
      this.currentFrame = Math.floor(this.videoReader.currentTime() * this.frameRate());
    }
    this.draw();
    
    this.eventManager.emit(EventName.onAnimationUpdate);
  }

  // bobihuang: 内存泄漏修复 - 提取为独立方法，避免每帧创建闭包
  private flushLoopCallback(): void {
    this.renderTimer = null;

    // 检查是否已经销毁
    if (this.destroyed || !this.playing) {
      return;
    }

    this.flushLoop();
  }
}
