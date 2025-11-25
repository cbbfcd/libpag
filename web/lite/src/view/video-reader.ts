import { Clock } from '../base/utils/clock';
import { destroyVerify } from '../decorators';
import { coverToMp4 } from '../generator/mp4-box-helper';
import { getWechatNetwork } from './utils';
import { addListener, removeAllListeners, removeListener } from './video-listener';

import type { VideoSequence } from '../base/video-sequence';

declare global {
  interface Window {
    WeixinJSBridge?: any;
  }
}

type K = keyof HTMLVideoElementEventMap;

const IS_WECHAT = navigator && /MicroMessenger/i.test(navigator.userAgent);

const playVideoElement = async (videoElement: HTMLVideoElement) => {
  if (IS_WECHAT && window.WeixinJSBridge) {
    await getWechatNetwork();
  }
  try {
    await videoElement.play();
  } catch (error: any) {
    const message = error?.message || '';
    const shouldIgnoreErrors = [
      'user denied permission',
      'save power',
      'interrupted by a call to pause',
      'interrupted by a new load request',
      'aborted',
      'can only be initiated by a user gesture'
    ];
    console.error(error);
    
    if (shouldIgnoreErrors.every((ignoreError) => !message.includes(ignoreError))) {
      throw new Error(error.message);
    }
  }
};

@destroyVerify
export class VideoReader {
  public static create(videoSequence: VideoSequence) {
    const videoReader = new VideoReader(videoSequence);
    const debugData = videoReader.load(videoSequence);
    return { videoReader: videoReader, debugData: debugData };
  }

  protected destroyed = false;
  protected frameRate = 0;

  private _duration: number;
  private videoElement: HTMLVideoElement | undefined;
  private playPromise: Promise<void> | null = null;

  // bobihuang 持有对 blobUrl 的引用先
  private blobUrl: string | null = null;

  public constructor(videoSequence: VideoSequence) {
    this._duration = videoSequence.frameCount / videoSequence.frameRate;
    this.frameRate = videoSequence.frameRate;
  }

  public getVideoElement(): HTMLVideoElement {
    return this.videoElement as HTMLVideoElement;
  }

  public progress() {
    return Math.round((this.videoElement!.currentTime / this._duration) * 100) / 100;
  }

  public duration() {
    return this._duration;
  }

  public currentTime() {
    return this.videoElement!.currentTime || 0;
  }

  public start() {
    this.playPromise = playVideoElement(this.videoElement as HTMLVideoElement);
    return this.playPromise;
  }

  public pause() {
    if (this.playPromise) {
      this.playPromise.then(() => {
        this.videoElement?.pause();
      }).catch(() => {
        // play was interrupted, safe to pause
        this.videoElement?.pause();
      });
      this.playPromise = null;
    } else {
      this.videoElement?.pause();
    }
  }

  public seek(time: number) {
    return new Promise<void>((resolve) => {
      const seekCallback = () => {
        removeListener(this.videoElement as HTMLVideoElement, 'seeked', seekCallback);
        resolve();
      };
      addListener(this.videoElement as HTMLVideoElement, 'seeked', seekCallback);
      this.videoElement!.currentTime = time;
    });
  }

  public addListener(event: K, handler: (this: HTMLVideoElement, ev: HTMLVideoElementEventMap[K]) => void) {
    addListener(this.videoElement as HTMLVideoElement, event, handler);
  }

  public removeAllListeners() {
    removeAllListeners(this.videoElement as HTMLVideoElement);
  }

  public getFrameData(callback: any): any {
    // NOP
  }

  public clearCallback() {
    // NOP
  }

  public destroy() {
    // bobihuang: 调整销毁顺序，先移除监听器（避免事件触发），再释放资源
    this.removeAllListeners();
    this.releaseVideoElement();
    this.releaseBlobUrl();
    this.playPromise = null;
    this.destroyed = true;
  }

  protected load(videoSequence: VideoSequence): any {
    // bobihuang 如果已存在 Blob URL，先释放
    this.releaseBlobUrl();

    this.videoElement = document.createElement('video');
    this.videoElement.style.display = 'none';
    this.videoElement.muted = true;
    this.videoElement.playsInline = true;
    this.videoElement.setAttribute('webkit-playsinline', 'true');
    const clock = new Clock();
    const mp4Data = coverToMp4(videoSequence);
    clock.mark('coverMP4');

    // bobihuang optimization: release raw data immediately after MP4 generation
    videoSequence.releaseRawData();

    // bobihuang 记录一下 blobUrl
    this.blobUrl = URL.createObjectURL(new Blob([mp4Data], { type: 'video/mp4' }));
    this.videoElement.src = this.blobUrl;
    this.videoElement.load();
    return {
      coverMP4: clock.measure('', 'coverMP4'),
    };
  }

  // bobihuang 释放
  private releaseBlobUrl() {
    if (this.blobUrl) {
      try {
        URL.revokeObjectURL(this.blobUrl);
      } catch (error) {
        // NOP
      }
      this.blobUrl = null;
    }
  }

  // bobihuang: 触发浏览器释放解码器，释放内存空间出来
  private releaseVideoElement() {
    if (this.videoElement) {
      try {
        this.pause();
        // 断开 Blob URL 连接
        this.videoElement.removeAttribute('src');
        // 清空 srcObject（如果有）
        this.videoElement.srcObject = null;
        // 触发浏览器释放解码器
        this.videoElement.load();
        
        // bobihuang: 从 DOM 移除（如果已添加），彻底切断引用
        if (this.videoElement?.parentNode) {
          this.videoElement.parentNode.removeChild(this.videoElement);
        }
      } catch (error) {
        // NOP
      }
      this.videoElement = undefined;
    }
  }
}
