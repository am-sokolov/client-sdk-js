import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeFrameCryptor {
  private participantIdentity: string;

  private trackId = '';

  constructor({ participantIdentity }: { participantIdentity: string }) {
    this.participantIdentity = participantIdentity;
  }

  setRtpMap() {}

  on() {}

  getTrackId() {
    return this.trackId;
  }

  getParticipantIdentity() {
    return this.participantIdentity;
  }

  setParticipant(participantIdentity: string) {
    this.participantIdentity = participantIdentity;
  }

  unsetParticipant() {}

  setSifTrailer() {}

  setVideoCodec() {}

  setupTransform(
    _kind: 'encode' | 'decode',
    _readable: ReadableStream,
    _writable: WritableStream,
    trackId: string,
  ) {
    this.trackId = trackId;
  }
}

class FakeParticipantKeyHandler {
  on() {}

  setKey = vi.fn();

  ratchetKey = vi.fn();

  resetKeyStatus = vi.fn();
}

async function loadWorkerModule() {
  vi.resetModules();
  vi.doMock('./FrameCryptor', () => ({
    FrameCryptor: FakeFrameCryptor,
    encryptionEnabledMap: new Map(),
  }));
  vi.doMock('./ParticipantKeyHandler', () => ({
    ParticipantKeyHandler: FakeParticipantKeyHandler,
  }));

  vi.stubGlobal('postMessage', vi.fn());
  vi.stubGlobal('onmessage', null);
  vi.stubGlobal('RTCTransformEvent', class RTCTransformEvent {});

  await import('./e2ee.worker');
}

function createTransformer(options: {
  kind: 'encode' | 'decode';
  trackKind: 'audio' | 'video' | 'unknown';
  codec?: 'av1' | 'vp9' | 'h264';
}) {
  return {
    readable: new ReadableStream(),
    writable: new WritableStream(),
    options: {
      participantIdentity: 'alice',
      trackId: 'track-1',
      kind: options.kind,
      trackKind: options.trackKind,
      codec: options.codec,
    },
    generateKeyFrame: vi.fn().mockResolvedValue(undefined),
    sendKeyFrameRequest: vi.fn().mockResolvedValue(undefined),
  };
}

describe('e2ee worker keyframe loop', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('starts generateKeyFrame loop for video encode transforms', async () => {
    vi.useFakeTimers();
    await loadWorkerModule();

    const transformer = createTransformer({ kind: 'encode', trackKind: 'video', codec: 'av1' });
    await (self as any).onrtctransform({ transformer });
    await Promise.resolve();

    expect(transformer.generateKeyFrame).toHaveBeenCalledTimes(1);
    expect(transformer.sendKeyFrameRequest).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(transformer.generateKeyFrame).toHaveBeenCalledTimes(2);
  });

  it('starts sendKeyFrameRequest loop for video decode transforms', async () => {
    vi.useFakeTimers();
    await loadWorkerModule();

    const transformer = createTransformer({ kind: 'decode', trackKind: 'video', codec: 'av1' });
    await (self as any).onrtctransform({ transformer });
    await Promise.resolve();

    expect(transformer.sendKeyFrameRequest).toHaveBeenCalledTimes(1);
    expect(transformer.generateKeyFrame).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(transformer.sendKeyFrameRequest).toHaveBeenCalledTimes(2);
  });

  it('does not start keyframe loop for audio transforms', async () => {
    vi.useFakeTimers();
    await loadWorkerModule();

    const transformer = createTransformer({ kind: 'encode', trackKind: 'audio' });
    await (self as any).onrtctransform({ transformer });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5000);

    expect(transformer.generateKeyFrame).not.toHaveBeenCalled();
    expect(transformer.sendKeyFrameRequest).not.toHaveBeenCalled();
  });
});
