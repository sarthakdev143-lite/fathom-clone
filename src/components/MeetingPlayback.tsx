"use client";

/**
 * Playback for the meeting detail page: an audio element, a transcript whose
 * lines seek the audio, and key moments that do the same.
 *
 * The page stays a server component. This module supplies a context provider
 * plus three consumers, so the player, the key moments inside the summary card,
 * and the transcript card can sit where they already are in the layout while
 * sharing one audio element and one notion of "where playback is".
 *
 * Degradation is decided on the server and passed in:
 *   - no audio (seeded demos, meetings recorded before playback existed): no
 *     player, but timestamps still jump to the matching transcript line;
 *   - no segment timings (Gemini fallback transcripts): the player works, but
 *     nothing is clickable, because there are no real offsets to seek to.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface PlaybackSegment {
  start: number;
  end: number;
  text: string;
}

export interface PlaybackMoment {
  timestamp: number;
  label: string;
}

interface PlaybackContextValue {
  meetingId: string;
  segments: PlaybackSegment[];
  /** True when segments carry real offsets, so lines and moments can seek. */
  hasTimings: boolean;
  /** True when there is a recording to play. */
  canPlay: boolean;
  activeIndex: number;
  follow: boolean;
  resumeFollow: () => void;
  pauseFollow: () => void;
  seekTo: (seconds: number, options?: { play?: boolean }) => void;
  registerAudio: (element: HTMLAudioElement | null) => void;
  /** Set when the page was opened with ?t=, so the line is brought into view. */
  revealOnLoad: boolean;
  /** Bumped on every explicit seek, so the transcript scrolls even if the active line did not change. */
  seekToken: number;
}

const PlaybackContext = createContext<PlaybackContextValue | null>(null);

function usePlayback(): PlaybackContextValue {
  const value = useContext(PlaybackContext);
  if (!value) throw new Error("Playback components must sit inside PlaybackProvider.");
  return value;
}

/**
 * Index of the segment playing at `seconds`: the last one that has started.
 * The epsilon absorbs float drift, so seeking to exactly a segment's start
 * lands on that segment rather than the one before it.
 */
function segmentIndexAt(segments: PlaybackSegment[], seconds: number): number {
  let low = 0;
  let high = segments.length - 1;
  let found = -1;
  const target = seconds + 0.05;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (segments[mid].start <= target) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Shortest faithful form for a ?t= value: "4.62", "90". */
function formatTParam(seconds: number): string {
  return String(Number(seconds.toFixed(2)));
}

export function PlaybackProvider({
  meetingId,
  segments,
  hasTimings,
  canPlay,
  initialTime,
  children,
}: {
  meetingId: string;
  segments: PlaybackSegment[];
  hasTimings: boolean;
  canPlay: boolean;
  initialTime: number | null;
  children: ReactNode;
}) {
  /*
   * The element lives in a ref because it is mutated (currentTime, play) and a
   * value held in state must not be. `audioReady` is the state half: it only
   * exists so the listener effect re-runs when the element mounts.
   */
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioReady, setAudioReady] = useState(false);
  const registerAudio = useCallback((element: HTMLAudioElement | null) => {
    audioRef.current = element;
    setAudioReady(element !== null);
  }, []);
  const [activeIndex, setActiveIndex] = useState(() =>
    initialTime !== null && hasTimings ? segmentIndexAt(segments, initialTime) : -1,
  );
  const [follow, setFollow] = useState(true);
  const [seekToken, setSeekToken] = useState(0);

  /**
   * True while the Infinity-duration fix is running. That fix seeks the element
   * to the far end of the file, and without this guard the resulting timeupdate
   * would briefly highlight the final line of the transcript.
   */
  const fixingRef = useRef(false);
  const pendingSeekRef = useRef<number | null>(initialTime);
  const pendingPlayRef = useRef(false);

  const updateActive = useCallback(
    (seconds: number) => {
      if (!hasTimings || fixingRef.current) return;
      const next = segmentIndexAt(segments, seconds);
      setActiveIndex((current) => (current === next ? current : next));
    },
    [hasTimings, segments],
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audioReady || !audio) return;

    const applyPending = () => {
      const target = pendingSeekRef.current;
      pendingSeekRef.current = null;
      if (target !== null) audio.currentTime = target;
      if (pendingPlayRef.current) {
        pendingPlayRef.current = false;
        audio.play().catch(() => {});
      }
    };

    /*
     * A WebM written by MediaRecorder has no Duration element and no Cues, so
     * Chrome reports `duration` as Infinity and the native scrubber cannot be
     * dragged. Seeking far past the end makes the browser scan to the last
     * cluster and learn the real length; playback is then restored to where it
     * should be. Verified: 12 s recording, Infinity -> 11.94 s.
     */
    const onLoadedMetadata = () => {
      if (Number.isFinite(audio.duration)) {
        applyPending();
        return;
      }
      fixingRef.current = true;
      const finish = () => {
        audio.removeEventListener("durationchange", onDurationChange);
        clearTimeout(timer);
        fixingRef.current = false;
        if (pendingSeekRef.current === null) pendingSeekRef.current = 0;
        applyPending();
      };
      const onDurationChange = () => {
        if (Number.isFinite(audio.duration)) finish();
      };
      const timer = setTimeout(finish, 5000);
      audio.addEventListener("durationchange", onDurationChange);
      audio.currentTime = 1e101;
    };

    const onTime = () => updateActive(audio.currentTime);

    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("seeked", onTime);
    if (audio.readyState >= 1) onLoadedMetadata();

    return () => {
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("seeked", onTime);
    };
  }, [audioReady, updateActive]);

  const seekTo = useCallback(
    (seconds: number, options?: { play?: boolean }) => {
      const target = Math.max(0, seconds);
      if (hasTimings) {
        setActiveIndex(segmentIndexAt(segments, target));
      }
      // An explicit jump is a request to see that line, so following resumes.
      setFollow(true);
      setSeekToken((n) => n + 1);

      const audio = audioRef.current;
      if (!audio || !canPlay) return;
      if (fixingRef.current) {
        pendingSeekRef.current = target;
        if (options?.play) pendingPlayRef.current = true;
        return;
      }
      audio.currentTime = target;
      if (options?.play) audio.play().catch(() => {});
    },
    [canPlay, hasTimings, segments],
  );

  const value = useMemo<PlaybackContextValue>(
    () => ({
      meetingId,
      segments,
      hasTimings,
      canPlay,
      activeIndex,
      follow,
      resumeFollow: () => {
        setFollow(true);
        setSeekToken((n) => n + 1);
      },
      pauseFollow: () => setFollow(false),
      seekTo,
      registerAudio,
      revealOnLoad: initialTime !== null,
      seekToken,
    }),
    [activeIndex, canPlay, follow, hasTimings, initialTime, meetingId, registerAudio, seekTo, seekToken, segments],
  );

  return <PlaybackContext.Provider value={value}>{children}</PlaybackContext.Provider>;
}

/** The recording, or a note explaining why there is none. */
export function AudioPlayer({
  audioUrl,
  note,
}: {
  audioUrl: string | null;
  note: string | null;
}) {
  const { registerAudio } = usePlayback();
  const [loadFailed, setLoadFailed] = useState(false);

  if (!audioUrl) {
    return note ? <p className="playback-note">{note}</p> : null;
  }

  return (
    <section className="player" aria-label="Meeting recording">
      <audio
        ref={registerAudio}
        src={audioUrl}
        controls
        preload="metadata"
        onError={() => setLoadFailed(true)}
      />
      {loadFailed && (
        // The blob can be deleted independently of the meeting row, so a dead
        // URL is a real state rather than a theoretical one.
        <p className="playback-note">
          The recording could not be loaded. It may have been removed from
          storage.
        </p>
      )}
      {note && !loadFailed && <p className="playback-note">{note}</p>}
    </section>
  );
}

/** Key moments, each seeking the recording and offering a shareable link. */
export function KeyMomentList({ moments }: { moments: PlaybackMoment[] }) {
  const { hasTimings, seekTo, meetingId } = usePlayback();
  const [copied, setCopied] = useState<number | null>(null);
  const [copyFailed, setCopyFailed] = useState<string | null>(null);

  const copyLink = useCallback(
    async (index: number, seconds: number) => {
      const url = new URL(`/meetings/${meetingId}`, window.location.origin);
      url.searchParams.set("t", formatTParam(seconds));
      const link = url.toString();
      setCopyFailed(null);
      try {
        await navigator.clipboard.writeText(link);
        setCopied(index);
        setTimeout(() => setCopied((c) => (c === index ? null : c)), 1600);
      } catch {
        // Clipboard access can be refused (permissions, insecure context), so
        // the link is shown for manual copying rather than failing silently.
        setCopyFailed(link);
      }
    },
    [meetingId],
  );

  if (!hasTimings) {
    // Without real offsets the model's timestamps are guesses, so they are not
    // shown as if they could be jumped to.
    return (
      <ul className="moments">
        {moments.map((moment) => (
          <li key={`${moment.timestamp}-${moment.label}`}>
            <span>{moment.label}</span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      <ul className="moments">
        {moments.map((moment, index) => (
          <li key={`${moment.timestamp}-${moment.label}`} className="moment-row">
            <button
              type="button"
              className="moment-seek"
              onClick={() => seekTo(moment.timestamp, { play: true })}
              aria-label={`Jump to ${formatClock(moment.timestamp)}: ${moment.label}`}
            >
              <code>{formatClock(moment.timestamp)}</code>
              <span>{moment.label}</span>
            </button>
            <button
              type="button"
              className="moment-copy"
              onClick={() => copyLink(index, moment.timestamp)}
            >
              {copied === index ? "Copied" : "Copy link to this moment"}
            </button>
          </li>
        ))}
      </ul>
      {copyFailed && (
        <p className="playback-note">
          Could not copy automatically. Link: <code>{copyFailed}</code>
        </p>
      )}
    </>
  );
}

const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);

/** The transcript, highlighted and scrolled in step with playback. */
export function TranscriptView({ fallbackText }: { fallbackText: string }) {
  const {
    segments,
    hasTimings,
    canPlay,
    activeIndex,
    follow,
    pauseFollow,
    resumeFollow,
    seekTo,
    revealOnLoad,
    seekToken,
  } = usePlayback();

  const listRef = useRef<HTMLOListElement | null>(null);
  const rowsRef = useRef(new Map<number, HTMLLIElement>());
  const revealedRef = useRef(false);

  /*
   * Only the transcript box scrolls during playback, never the page, so a
   * reader looking at the summary is not dragged down. The single exception is
   * a ?t= link, where bringing that line on screen is the whole point.
   */
  useEffect(() => {
    if (activeIndex < 0) return;
    const row = rowsRef.current.get(activeIndex);
    const list = listRef.current;
    if (!row || !list) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const behavior: ScrollBehavior = reduceMotion ? "auto" : "smooth";

    if (revealOnLoad && !revealedRef.current) {
      revealedRef.current = true;
      row.scrollIntoView({ block: "center", behavior: "auto" });
      return;
    }

    if (!follow) return;

    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    const viewTop = list.scrollTop + 32;
    const viewBottom = list.scrollTop + list.clientHeight - 48;
    if (top < viewTop || bottom > viewBottom) {
      list.scrollTo({ top: Math.max(0, top - list.clientHeight * 0.3), behavior });
    }
  }, [activeIndex, follow, revealOnLoad, seekToken]);

  /*
   * Auto-scroll yields to the reader. These events only come from a person -
   * programmatic scrollTo fires none of them - so there is no need to tell the
   * two apart with timing heuristics.
   */
  useEffect(() => {
    const list = listRef.current;
    if (!list || !canPlay) return;
    const onWheel = () => pauseFollow();
    const onTouch = () => pauseFollow();
    const onKey = (event: KeyboardEvent) => {
      if (NAV_KEYS.has(event.key)) pauseFollow();
    };
    // A press on the list itself, not a line inside it, is a scrollbar drag.
    const onPointer = (event: PointerEvent) => {
      if (event.target === list) pauseFollow();
    };
    list.addEventListener("wheel", onWheel, { passive: true });
    list.addEventListener("touchmove", onTouch, { passive: true });
    list.addEventListener("keydown", onKey);
    list.addEventListener("pointerdown", onPointer);
    return () => {
      list.removeEventListener("wheel", onWheel);
      list.removeEventListener("touchmove", onTouch);
      list.removeEventListener("keydown", onKey);
      list.removeEventListener("pointerdown", onPointer);
    };
  }, [canPlay, pauseFollow]);

  if (!hasTimings) {
    return <p style={{ margin: 0 }}>{fallbackText}</p>;
  }

  return (
    <>
      {canPlay && !follow && (
        <div className="follow-bar">
          <span className="muted small">Auto-scroll paused while you read.</span>
          <button type="button" className="follow-resume" onClick={resumeFollow}>
            Follow playback
          </button>
        </div>
      )}
      <ol
        className="transcript"
        ref={listRef}
        tabIndex={0}
        aria-label="Transcript"
      >
        {segments.map((segment, index) => (
          <li
            key={`${segment.start}-${segment.end}`}
            ref={(element) => {
              if (element) rowsRef.current.set(index, element);
              else rowsRef.current.delete(index);
            }}
          >
            <button
              type="button"
              className={`transcript-row${index === activeIndex ? " active" : ""}`}
              aria-current={index === activeIndex ? "true" : undefined}
              aria-label={`${canPlay ? "Play from" : "Show"} ${formatClock(segment.start)}`}
              onClick={() => seekTo(segment.start, { play: true })}
            >
              <code className="transcript-time">{formatClock(segment.start)}</code>
              <span>{segment.text}</span>
            </button>
          </li>
        ))}
      </ol>
    </>
  );
}
