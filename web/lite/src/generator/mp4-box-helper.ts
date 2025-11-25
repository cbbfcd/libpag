import { VideoFrame } from '../base/video-frame';
import { VideoSequence } from '../base/video-sequence';
import { IS_IOS } from '../constant';
import { BoxParam, MP4Generator, MP4Track } from './mp4-generator';

const SEQUENCE_NUMBER = 1;
const BASE_MEDIA_DECODE_TIME = 0;
const BASE_MEDIA_TIME_SCALE = 6000;

export const coverToMp4 = (videoSequence: VideoSequence) => {
  const sequence = IS_IOS ? getVirtualSequence(videoSequence) : videoSequence;
  const mp4Track = makeMp4Track(sequence);
  if (!mp4Track || mp4Track.len === 0) throw new Error('mp4Track is empty');
  const boxParam: BoxParam = {
    offset: 0,
    tracks: [mp4Track],
    track: mp4Track,
    duration: mp4Track.duration,
    timescale: mp4Track.timescale,
    sequenceNumber: SEQUENCE_NUMBER,
    baseMediaDecodeTime: BASE_MEDIA_DECODE_TIME,
    nalusBytesLen: mp4Track.len,
    videoSequence: sequence,
  };
  const mp4Generator = new MP4Generator(boxParam);
  const ftyp = mp4Generator.ftyp();
  const moov = mp4Generator.moov();
  const moof = mp4Generator.moof();

  // 优化内存分配：一次性分配完整 MP4 缓冲区，避免 mdat() 和 concatUint8Arrays 的多次分配
  // 原方案：mdat(120MB) + makeBox(120MB) + concat(120MB) = 360MB 峰值
  // 优化后：直接写入预分配缓冲区 = 120MB 峰值，减少 66% 内存占用
  const mdatSize = 8 + mp4Track.len;
  const totalSize = ftyp.byteLength + moov.byteLength + moof.byteLength + mdatSize;
  const result = new Uint8Array(totalSize);

  let offset = 0;
  result.set(ftyp, offset);
  offset += ftyp.byteLength;
  result.set(moov, offset);
  offset += moov.byteLength;
  result.set(moof, offset);
  offset += moof.byteLength;

  // 直接写入 mdat box header（避免 makeBox 的额外分配）
  const view = new DataView(result.buffer, offset, 8);
  view.setUint32(0, mdatSize, false);
  result.set([0x6d, 0x64, 0x61, 0x74], offset + 4); // 'mdat'
  offset += 8;

  // 直接复制视频数据到 result（避免 mdat() 的中间 buffer 分配）
  sequence.headers.forEach((header) => {
    result.set(new Uint8Array(header.data.data()), offset);
    offset += header.length;
  });

  sequence.frames.forEach((frame) => {
    result.set(new Uint8Array(frame.fileBytes.data.data()), offset);
    offset += frame.fileBytes.length;
  });

  return result;
};

const makeMp4Track = (videoSequence: VideoSequence) => {
  if (videoSequence.headers.length < 2) throw new Error('Bad header data in video sequence!');
  if (videoSequence.frames.length === 0) throw new Error('There is no frame data in the video sequence!');
  const mp4Track: MP4Track = {
    id: 1,
    type: 'video',
    timescale: BASE_MEDIA_TIME_SCALE,
    duration: Math.floor((videoSequence.frames.length * BASE_MEDIA_TIME_SCALE) / videoSequence.frameRate),
    width: videoSequence.getVideoWidth(),
    height: videoSequence.getVideoHeight(),
    sps: [videoSequence.headers[0]],
    pps: [videoSequence.headers[1]],
    implicitOffset: getImplicitOffset(videoSequence.frames),
    len: 0,
    pts: [],
    samples: [],
  };

  const headerLen = videoSequence.headers.reduce((pre, cur) => pre + cur.length, 0);
  const sampleDelta = mp4Track.duration / videoSequence.frames.length;
  videoSequence.frames.forEach((frame, index) => {
    let sampleSize = frame.fileBytes.length ?? 0;
    if (index === 0) {
      sampleSize += headerLen;
    }
    mp4Track.len += sampleSize;
    mp4Track.pts.push(frame.frame);
    mp4Track.samples.push({
      index,
      size: sampleSize,
      duration: sampleDelta,
      cts: (frame.frame + mp4Track.implicitOffset - index) * sampleDelta,
      flags: {
        isKeyFrame: frame.isKeyframe,
        isNonSync: frame.isKeyframe ? 0 : 1,
        dependsOn: frame.isKeyframe ? 2 : 1,
        isLeading: 0,
        isDependedOn: 0,
        hasRedundancy: 0,
        degradPrio: 0,
      },
    });
  });
  return mp4Track;
};

const getImplicitOffset = (videoFrames: VideoFrame[]) => {
  return Math.max(...videoFrames.map((videoFrame, index) => index - videoFrame.frame));
};

const getVirtualSequence = (videoSequence: VideoSequence): VideoSequence => {
  const len = videoSequence.frames.length;
  for (let index = 0; index < videoSequence.frames.length; index++) {
    const frame = { ...videoSequence.frames[index] };
    if (frame.isKeyframe && index > 0) {
      break;
    }
    frame.frame += len;
    videoSequence.frames.push(frame);
  }
  return videoSequence;
};
