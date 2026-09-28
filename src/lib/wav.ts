/**
 * Encodes raw PCM as a self-contained WAV file.
 *
 * This exists because a WebM stream from MediaRecorder cannot be transcribed
 * while it is still being written: ffmpeg rejects a bare cluster, and
 * prepending the header does not help, because the container is only valid once
 * the recording is complete. Verified against Groq Whisper with a 10-second
 * Chrome recording - both the bare second chunk and header-plus-chunk failed
 * with `invalid_media_file`, while the complete file transcribed fine.
 *
 * Tapping PCM through the Web Audio API sidesteps the container entirely: every
 * slice is a normal, independently valid WAV.
 */

/**
 * Whisper resamples everything to 16 kHz mono internally, so sending a 48 kHz
 * slice uploads three times the bytes for no accuracy gain. Box-filter
 * averaging over each output sample's span is a cheap low-pass that avoids the
 * aliasing plain decimation would add; for speech at 16 kHz it is plenty.
 */
export const SPEECH_SAMPLE_RATE = 16_000;

export function downsample(
  samples: Float32Array,
  fromRate: number,
  toRate = SPEECH_SAMPLE_RATE,
): Float32Array {
  if (fromRate <= toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/** Interleaved Float32 samples -> 16-bit mono PCM WAV. */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number,
  channels = 1,
): Blob {
  const bytesPerSample = 2;
  const dataLength = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeString(36, "data");
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    // Clamp before scaling, otherwise wrap-around turns loud samples into noise.
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: "audio/wav" });
}
