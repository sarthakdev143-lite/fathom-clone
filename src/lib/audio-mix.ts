/**
 * Two-sided capture: microphone plus the audio a browser tab is playing.
 *
 * A meeting in a browser tab mixes every participant into the tab's output
 * stream, so capturing the tab captures the remote side that a microphone
 * cannot hear. Both sources are summed through the Web Audio API into a single
 * `MediaStreamAudioDestinationNode`, and that one stream is what gets recorded.
 * Downstream the file is just audio, so the transcribe and summarize pipeline is
 * untouched.
 *
 * The mix deliberately never reaches `AudioContext.destination`. Routing tab
 * audio back to the speakers while the same tab is playing it is a feedback
 * loop; the destination node is a sink for recording only.
 *
 * Browser support is partial. Chrome and Edge expose tab audio, Safari does
 * not, and Firefox is inconsistent. `tabAudioSupported()` is checked before the
 * option is offered so the choice is never presented as available when it is not.
 */

export type CaptureMode = "mic" | "tab";

export function tabAudioSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function"
  );
}

export class TabAudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TabAudioError";
  }
}

/**
 * Opens the browser's "share this tab" picker and returns a stream holding only
 * its audio track.
 *
 * `video: true` is required even when only audio is wanted - Chrome rejects a
 * display capture with no video track - so the video track is stopped
 * immediately rather than being held open.
 */
export async function requestTabAudioStream(): Promise<MediaStream> {
  if (!tabAudioSupported()) {
    throw new TabAudioError(
      "This browser cannot capture tab audio. Chrome and Edge can; Safari cannot. " +
        "Record the microphone instead, or use a desktop app with system audio capture.",
    );
  }

  let display: MediaStream;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotAllowedError") {
      throw new TabAudioError(
        "Tab sharing was cancelled, so nothing was recorded.",
      );
    }
    throw new TabAudioError(
      `Could not start tab capture: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
    );
  }

  // The picker always yields video; stop it so no camera indicator lingers.
  for (const track of display.getVideoTracks()) track.stop();

  const audioTracks = display.getAudioTracks();
  if (audioTracks.length === 0) {
    for (const track of display.getTracks()) track.stop();
    throw new TabAudioError(
      'No audio was shared. In the picker, tick "Also share tab audio" and choose ' +
        "a tab that is actually playing the meeting. Without that, only your " +
        "microphone would be recorded.",
    );
  }

  return new MediaStream(audioTracks);
}

export interface MixedCapture {
  /** The stream to record: both sources summed. */
  stream: MediaStream;
  audioContext: AudioContext;
  /** Called when the user stops sharing the tab mid-recording. */
  onTabTrackEnded: (handler: () => void) => void;
  dispose: () => void;
}

/**
 * Sums the microphone and tab audio into one stream.
 *
 * Both sources feed a mix bus, and the bus feeds two sinks: the recording
 * destination, and a muted gain that exists purely to keep the graph processing
 * for the live caption tap. The bus is never connected to the speakers.
 */
export function mixAudioSources(options: {
  micStream: MediaStream;
  tabStream: MediaStream;
}): MixedCapture {
  const audioContext = new AudioContext();
  const mixBus = audioContext.createGain();
  mixBus.gain.value = 1;

  const micSource = audioContext.createMediaStreamSource(options.micStream);
  const tabSource = audioContext.createMediaStreamSource(options.tabStream);

  const destination = audioContext.createMediaStreamDestination();
  // Sinks into a mute rather than ctx.destination: reaching the speakers would
  // loop the tab audio straight back into the call.
  const keepAlive = audioContext.createGain();
  keepAlive.gain.value = 0;

  micSource.connect(mixBus);
  tabSource.connect(mixBus);
  mixBus.connect(destination);
  mixBus.connect(keepAlive);
  keepAlive.connect(audioContext.destination);

  const tabTracks = options.tabStream.getAudioTracks();
  const endedHandlers: (() => void)[] = [];
  for (const track of tabTracks) {
    track.addEventListener("ended", () => {
      for (const handler of endedHandlers) handler();
    });
  }

  return {
    stream: destination.stream,
    audioContext,
    onTabTrackEnded(handler) {
      endedHandlers.push(handler);
    },
    dispose() {
      endedHandlers.length = 0;
      for (const track of tabTracks) {
        try {
          track.removeEventListener("ended", () => undefined);
        } catch {
          // Track may already be detached; nothing to do.
        }
        track.stop();
      }
      try {
        micSource.disconnect();
        tabSource.disconnect();
        mixBus.disconnect();
        destination.disconnect();
        keepAlive.disconnect();
      } catch {
        // Nodes may already be torn down.
      }
      audioContext.close().catch(() => {});
    },
  };
}
