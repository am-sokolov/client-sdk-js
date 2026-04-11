import { afterEach, describe, expect, it, vi } from 'vitest';

type WorkerLike = Pick<Worker, 'postMessage' | 'onmessage' | 'onerror'>;

function createWorker(): WorkerLike {
  return {
    postMessage: vi.fn(),
    onmessage: null,
    onerror: null,
  };
}

function createStreams() {
  return {
    readable: new ReadableStream(),
    writable: new WritableStream(),
  };
}

async function loadManager(options: { scriptTransformSupported: boolean; chromiumBased: boolean }) {
  vi.resetModules();

  vi.doMock('./utils', async () => {
    const actual = await vi.importActual<typeof import('./utils')>('./utils');
    return {
      ...actual,
      isScriptTransformSupported: () => options.scriptTransformSupported,
    };
  });

  vi.doMock('../room/utils', async () => {
    const actual = await vi.importActual<typeof import('../room/utils')>('../room/utils');
    return {
      ...actual,
      isChromiumBased: () => options.chromiumBased,
    };
  });

  const [{ E2EEManager }, { BaseKeyProvider }] = await Promise.all([
    import('./E2eeManager'),
    import('./KeyProvider'),
  ]);

  return { E2EEManager, BaseKeyProvider };
}

describe('E2EEManager sender setup', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses script transforms on Chromium when available so the worker can drive keyframes', async () => {
    const { E2EEManager, BaseKeyProvider } = await loadManager({
      scriptTransformSupported: true,
      chromiumBased: true,
    });

    const fakeTransform = vi.fn(function FakeTransform(worker: Worker, options: unknown) {
      (this as any).worker = worker;
      (this as any).options = options;
    });
    vi.stubGlobal('RTCRtpScriptTransform', fakeTransform);

    const worker = createWorker();
    const manager = new E2EEManager(
      {
        keyProvider: new BaseKeyProvider({ sharedKey: true }),
        worker: worker as Worker,
      },
      false,
    );

    (manager as any).room = { localParticipant: { identity: 'alice' } };

    const sender = {
      createEncodedStreams: vi.fn(() => createStreams()),
      generateKeyFrame: vi.fn(),
      sendKeyFrameRequest: vi.fn(),
    } as unknown as RTCRtpSender;

    (manager as any).handleSender(sender, 'track-1', 'video', 'av1');

    expect(fakeTransform).toHaveBeenCalledOnce();
    expect((sender as any).transform).toBeTruthy();
    expect((sender as any).createEncodedStreams).not.toHaveBeenCalled();
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect((sender as any).generateKeyFrame).not.toHaveBeenCalled();
    expect((sender as any).sendKeyFrameRequest).not.toHaveBeenCalled();
  });

  it('falls back to encoded streams when script transform initialization fails', async () => {
    const { E2EEManager, BaseKeyProvider } = await loadManager({
      scriptTransformSupported: true,
      chromiumBased: true,
    });

    const fakeTransform = vi.fn(() => {
      throw new DOMException('InvalidStateError', 'InvalidStateError');
    });
    vi.stubGlobal('RTCRtpScriptTransform', fakeTransform);

    const worker = createWorker();
    const manager = new E2EEManager(
      {
        keyProvider: new BaseKeyProvider({ sharedKey: true }),
        worker: worker as Worker,
      },
      false,
    );

    (manager as any).room = { localParticipant: { identity: 'alice' } };

    const sender = {
      createEncodedStreams: vi.fn(() => createStreams()),
      generateKeyFrame: vi.fn(),
      sendKeyFrameRequest: vi.fn(),
    } as unknown as RTCRtpSender;

    (manager as any).handleSender(sender, 'track-2', 'video', 'av1');

    expect(fakeTransform).toHaveBeenCalledOnce();
    expect((sender as any).createEncodedStreams).toHaveBeenCalledOnce();
    expect((worker.postMessage as any).mock.calls).toHaveLength(1);
    expect((worker.postMessage as any).mock.calls[0][0]).toMatchObject({
      kind: 'encode',
      data: {
        participantIdentity: 'alice',
        trackId: 'track-2',
        codec: 'av1',
        isReuse: false,
      },
    });
    expect((sender as any).generateKeyFrame).not.toHaveBeenCalled();
    expect((sender as any).sendKeyFrameRequest).not.toHaveBeenCalled();
  });

  it('removes local sender transforms when a local track is unpublished', async () => {
    const { E2EEManager, BaseKeyProvider } = await loadManager({
      scriptTransformSupported: false,
      chromiumBased: true,
    });

    const worker = createWorker();
    const manager = new E2EEManager(
      {
        keyProvider: new BaseKeyProvider({ sharedKey: true }),
        worker: worker as Worker,
      },
      false,
    );

    const localParticipant = {
      identity: 'alice',
      on: vi.fn().mockReturnThis(),
    };
    const room = {
      localParticipant,
      on: vi.fn().mockReturnThis(),
      remoteParticipants: new Map(),
    };

    (manager as any).setupEventListeners(room, new BaseKeyProvider({ sharedKey: true }));

    const localTrackPublishedHandler = localParticipant.on.mock.calls.find(
      ([event]: [string]) => event === 'localTrackPublished',
    )?.[1];
    const localTrackUnpublishedHandler = localParticipant.on.mock.calls.find(
      ([event]: [string]) => event === 'localTrackUnpublished',
    )?.[1];

    expect(localTrackPublishedHandler).toBeTypeOf('function');
    expect(localTrackUnpublishedHandler).toBeTypeOf('function');

    localTrackPublishedHandler({
      trackSid: 'TR_pub',
      track: {
        mediaStreamID: 'track-1',
        kind: 'audio',
      },
    });

    localTrackUnpublishedHandler({
      trackSid: 'TR_pub',
      track: undefined,
    });

    expect(worker.postMessage).toHaveBeenCalledWith({
      kind: 'removeTransform',
      data: {
        participantIdentity: 'alice',
        trackId: 'track-1',
      },
    });
  });
});
