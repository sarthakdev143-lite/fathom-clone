import "./helpers/env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { db } from "@/lib/db";
import { acquireLease } from "@/lib/lease";
import { createLiveMeeting, finishLiveMeeting, touchLiveMeeting } from "@/lib/live";
import { createMeeting, getMeeting, readProgress, writeProgress } from "@/lib/meetings";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  INTERRUPTED_EMPTY,
  INTERRUPTED_WITH_TRANSCRIPT,
  PROCESSING_STALLED,
  sweepOrphanBlobs,
  sweepStaleMeetings,
  type BlobStore,
} from "@/lib/sweep";

async function setRow(id: string, fields: Record<string, string | number | null>) {
  const client = await db();
  const keys = Object.keys(fields);
  await client.execute({
    sql: `UPDATE meetings SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
    args: [...keys.map((k) => fields[k]), id],
  });
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe("migrations", () => {
  it("apply once and leave the schema at the latest version", async () => {
    const client = await db();
    const version = await client.execute("SELECT MAX(version) AS v FROM _migrations");
    const columns = await client.execute("PRAGMA table_info(meetings)");
    const names = columns.rows.map((r) => String(r.name));
    for (const col of ["transcript_progress_json", "summary_progress_json", "lease_until", "lease_owner"]) {
      assert.ok(names.includes(col), `missing ${col}`);
    }
    assert.ok(Number(version.rows[0].v) >= 13);
    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
    assert.ok(tables.rows.some((r) => r.name === "rate_limits"));
  });
});

describe("processing lease", () => {
  it("admits exactly one holder until released", async () => {
    const meeting = await createMeeting({ title: "lease", source: "upload" });
    const first = await acquireLease(meeting.id);
    assert.ok(first);
    assert.equal(await acquireLease(meeting.id), null);

    await first.release();
    const second = await acquireLease(meeting.id);
    assert.ok(second);
    await second.release();
  });

  it("expires, so a killed request cannot block the meeting forever", async () => {
    const meeting = await createMeeting({ title: "lease-ttl", source: "upload" });
    assert.ok(await acquireLease(meeting.id, 1));
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(await acquireLease(meeting.id));
  });

  it("a stale holder cannot release someone else's lease", async () => {
    const meeting = await createMeeting({ title: "lease-owner", source: "upload" });
    const stale = await acquireLease(meeting.id, 1);
    await new Promise((r) => setTimeout(r, 10));
    const fresh = await acquireLease(meeting.id);
    await stale!.release();
    assert.equal(await acquireLease(meeting.id), null, "fresh lease must survive");
    await fresh!.release();
  });
});

describe("progress columns", () => {
  it("round-trip JSON and clear with null", async () => {
    const meeting = await createMeeting({ title: "progress", source: "upload" });
    await writeProgress(meeting.id, "transcript_progress_json", { v: 1, nextOffset: 900 });
    assert.deepEqual(await readProgress(meeting.id, "transcript_progress_json"), { v: 1, nextOffset: 900 });
    await writeProgress(meeting.id, "transcript_progress_json", null);
    assert.equal(await readProgress(meeting.id, "transcript_progress_json"), null);
  });
});

describe("rate limiter", () => {
  const rule = { name: "test", limit: 3, windowSeconds: 60 };

  it("allows up to the limit, then refuses, per key", async () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 10);
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await checkRateLimit("1.1.1.1", rule, now));
    assert.deepEqual(results.map((r) => r.allowed), [true, true, true, false]);
    assert.equal(results[3].retryAfterSeconds, 50);
    assert.equal((await checkRateLimit("2.2.2.2", rule, now)).allowed, true);
  });

  it("resets in the next window", async () => {
    const now = Date.UTC(2026, 0, 1, 12, 1, 5);
    assert.equal((await checkRateLimit("1.1.1.1", rule, now)).allowed, true);
  });
});

describe("stale meeting sweep", () => {
  it("closes abandoned live sessions, keeping any partial transcript", async () => {
    const withText = await createLiveMeeting("abandoned with text");
    const empty = await createLiveMeeting("abandoned empty");
    const active = await createLiveMeeting("still recording");
    await setRow(withText, { transcript: "we agreed to ship", updated_at: minutesAgo(30) });
    await setRow(empty, { updated_at: minutesAgo(30) });
    await setRow(active, { updated_at: minutesAgo(1) });

    const result = await sweepStaleMeetings();
    assert.ok(result.interruptedLive >= 2);

    const a = await getMeeting(withText);
    assert.equal(a?.status, "failed");
    assert.equal(a?.status_error, INTERRUPTED_WITH_TRANSCRIPT);
    assert.equal(a?.transcript, "we agreed to ship");
    assert.equal((await getMeeting(empty))?.status_error, INTERRUPTED_EMPTY);
    assert.equal((await getMeeting(active))?.status, "live");
  });

  it("a swept live meeting still finalises if the tab was alive after all", async () => {
    const id = await createLiveMeeting("late finish");
    await setRow(id, { updated_at: minutesAgo(30) });
    await sweepStaleMeetings();
    await finishLiveMeeting({
      id,
      audioUrl: "https://s.public.blob.vercel-storage.com/audio/x.webm",
      filename: "x.webm",
      mime: "audio/webm",
      size: 10,
      durationSeconds: 5,
    });
    const row = await getMeeting(id);
    assert.equal(row?.status, "uploaded");
    assert.equal(row?.status_error, null);
  });

  it("marks stalled processing failed, but not while a lease is held", async () => {
    const stalled = await createMeeting({ title: "stalled", source: "upload" });
    const leased = await createMeeting({ title: "leased", source: "upload" });
    await setRow(stalled.id, { status: "transcribing", updated_at: minutesAgo(40) });
    await setRow(leased.id, {
      status: "summarizing",
      updated_at: minutesAgo(40),
      lease_until: Date.now() + 60_000,
    });

    await sweepStaleMeetings();
    assert.equal((await getMeeting(stalled.id))?.status_error, PROCESSING_STALLED);
    assert.equal((await getMeeting(leased.id))?.status, "summarizing");
  });

  it("the poll heartbeat keeps a live row fresh", async () => {
    const id = await createLiveMeeting("heartbeat");
    await setRow(id, { updated_at: minutesAgo(9) });
    await touchLiveMeeting(id);
    await sweepStaleMeetings(Date.now() + 2 * 60_000);
    assert.equal((await getMeeting(id))?.status, "live");
  });
});

describe("orphan blob sweep", () => {
  it("deletes only old, unreferenced audio", async () => {
    const referenced = "https://s.public.blob.vercel-storage.com/audio/kept.webm";
    await createMeeting({ title: "has audio", source: "upload", audioUrl: referenced });

    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const young = new Date(Date.now() - 60 * 60 * 1000);
    const deleted: string[] = [];
    const store: BlobStore = {
      list: async () => ({
        blobs: [
          { url: referenced, uploadedAt: old },
          { url: "https://s.public.blob.vercel-storage.com/audio/orphan.webm", uploadedAt: old },
          { url: "https://s.public.blob.vercel-storage.com/audio/uploading.webm", uploadedAt: young },
        ],
        hasMore: false,
      }),
      del: async (urls) => {
        deleted.push(...urls);
      },
    };

    const result = await sweepOrphanBlobs(Date.now(), store);
    assert.equal(result.scanned, 3);
    assert.deepEqual(deleted, ["https://s.public.blob.vercel-storage.com/audio/orphan.webm"]);
  });
});
