/**
 * NOT IMPLEMENTED — STUB ONLY.
 *
 * The assignment explicitly scopes out a bot that joins Zoom / Google Meet /
 * Teams calls on the user's behalf. This file documents what that feature
 * would need and refuses to pretend otherwise.
 *
 * Nothing here makes a network call, opens a meeting, or returns audio. The
 * single exported function always throws, so no caller can accidentally depend
 * on a working implementation. There is no mock success path, because a stub
 * that returns fake data reads as a working feature to whoever tries it next.
 *
 * If this is ever implemented for real, the hard parts are not the OAuth dance:
 *
 *   1. Meeting audio. A bot that joins a call has to pull the mixed audio track
 *      out of the call. On Zoom and Meet that means a real-time media client
 *      (the meeting platform's own SDK, or a SIP/WebRTC leg into the call),
 *      which is where essentially all of the difficulty and the vendor-specific
 *      breakage lives.
 *   2. Bot registration and consent. Each platform requires an approved OAuth
 *      app, a bot user created in the admin console, and — for Meet and Teams —
 *      published marketplace approval before the bot can join anything.
 *   3. Recording consent. Most jurisdictions and several enterprise customers
 *      require all participants to be notified that the call is being recorded.
 *      Handling that join/leave announcement correctly is a product requirement,
 *      not a detail.
 *   4. Reconnection. Long calls drop, the platform rotates media servers, and a
 *      bot that silently stops recording is worse than one that fails loudly.
 *   5. Cost and quota. A bot on a call holds a media subscription for the whole
 *      meeting, which is billed per participant.
 *
 * Until then the supported capture paths are the ones in `Recorder`: record
 * locally with MediaRecorder, or upload a file.
 */

export type MeetingPlatform = "zoom" | "google_meet" | "teams";

export interface JoinMeetingRequest {
  platform: MeetingPlatform;
  /** The join URL a human would paste into their browser. */
  meetingUrl: string;
}

export const SUPPORTED_PLATFORMS: MeetingPlatform[] = [
  "zoom",
  "google_meet",
  "teams",
];

export const NOT_IMPLEMENTED_MESSAGE =
  "Joining meetings with a bot is out of scope for this build. Record with the " +
  "microphone or upload an audio file instead.";

/** Always throws. There is no partial or simulated success. */
export async function joinMeetingAsBot(
  _request: JoinMeetingRequest,
): Promise<never> {
  throw new Error(NOT_IMPLEMENTED_MESSAGE);
}
