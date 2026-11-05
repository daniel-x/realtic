/**
 * Codec and feature capabilities (plan section 10.1, 10.6), exchanged once in `hello`.
 */

const DECODE_PROBES = ["video/VP8", "video/VP9", "video/H264", "video/AV1"];

function codecs(cls, kind) {
  try {
    const caps = cls?.getCapabilities?.(kind);
    if (!caps) return undefined;
    return [...new Set(caps.codecs.map((c) => c.mimeType).filter((m) => !/rtx|red|ulpfec|flexfec|telephone-event|CN$/i.test(m)))];
  } catch {
    return undefined;
  }
}

/**
 * Estimates encoding of a video format with `mediaCapabilities.encodingInfo`. Firefox accepts the
 * type "transmission" only, Chromium "webrtc". Null when the browser gives no estimate.
 * @param {{contentType?: string, width: number, height: number, bitrate: number, framerate: number}} format
 * @returns {Promise<{supported: boolean, smooth: boolean, powerEfficient: boolean}|null>}
 */
export async function probeEncoding({ contentType = "video/VP8", width, height, bitrate, framerate }) {
  const mc = globalThis.navigator?.mediaCapabilities;
  if (!mc?.encodingInfo) return null;
  const video = { contentType, width, height, bitrate, framerate };
  for (const type of ["webrtc", "transmission"]) {
    try {
      const r = await mc.encodingInfo({ type, video });
      return { supported: r.supported, smooth: r.smooth, powerEfficient: r.powerEfficient };
    } catch {
      // the browser rejects this type, the next one may work
    }
  }
  return null;
}

/** Feature flags of this browser. */
export function features() {
  const g = globalThis;
  return {
    setSinkId: typeof g.HTMLMediaElement !== "undefined" && "setSinkId" in g.HTMLMediaElement.prototype,
    getDisplayMedia: !!g.navigator?.mediaDevices?.getDisplayMedia,
    encodedTransform: typeof g.RTCRtpScriptTransform !== "undefined",
    encodedStreams: typeof g.RTCRtpSender !== "undefined" && "createEncodedStreams" in g.RTCRtpSender.prototype,
    trackGenerator: typeof g.MediaStreamTrackGenerator !== "undefined" || typeof g.VideoTrackGenerator !== "undefined",
    networkInformation: !!g.navigator?.connection,
  };
}

/**
 * Collects codec lists, decode probes and features. Never rejects.
 * @param {number} [timeoutMs]
 */
export async function collect(timeoutMs = 1000) {
  const g = globalThis;
  const out = {
    send: { audio: codecs(g.RTCRtpSender, "audio"), video: codecs(g.RTCRtpSender, "video") },
    recv: { audio: codecs(g.RTCRtpReceiver, "audio"), video: codecs(g.RTCRtpReceiver, "video") },
    decode: {},
    encode: {},
    features: features(),
  };
  const mc = g.navigator?.mediaCapabilities;
  if (mc?.decodingInfo) {
    const probes = DECODE_PROBES.map(async (contentType) => {
      try {
        const r = await mc.decodingInfo({ type: "webrtc", video: { contentType, width: 1280, height: 720, bitrate: 1500000, framerate: 30 } });
        out.decode[contentType] = { supported: r.supported, smooth: r.smooth, powerEfficient: r.powerEfficient };
      } catch {
        // probe not supported for this type
      }
    });
    const encodeProbes = DECODE_PROBES.map(async (contentType) => {
      const r = await probeEncoding({ contentType, width: 1280, height: 720, bitrate: 1500000, framerate: 30 });
      if (r) out.encode[contentType] = r;
    });
    await Promise.race([Promise.all([...probes, ...encodeProbes]), new Promise((r) => setTimeout(r, timeoutMs))]);
  }
  return out;
}
