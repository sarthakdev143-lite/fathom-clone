export type MeetingStatus =
  | "uploaded"
  | "transcribing"
  | "transcribed"
  | "summarizing"
  | "ready"
  | "failed";

export type MeetingSource = "recording" | "upload" | "seed";

export interface Meeting {
  id: string;
  title: string;
  source: MeetingSource;
  audio_filename: string | null;
  audio_mime: string | null;
  audio_bytes: number | null;
  duration_seconds: number | null;
  status: MeetingStatus;
  status_error: string | null;
  transcript: string | null;
  transcript_language: string | null;
  summary_json: string | null;
  /** Where the audio lives in blob storage. Null for pre-migration rows. */
  audio_url?: string | null;
  created_at: string;
  updated_at: string;
}
