/**
 * Seed data: four realistic-sounding meetings, summarised through the real
 * step 3 pipeline rather than with hand-written summaries.
 *
 *   npm run db:seed
 *
 * Only rows with source = 'seed' are replaced, so real recordings captured
 * through the UI are never touched. Re-running is safe.
 */

import { createMeeting, setStatus } from "../src/lib/meetings";
import { summarizeMeeting } from "../src/lib/summarize";
import { db } from "../src/lib/db";
import type { MeetingSummary } from "../src/lib/summary";

interface SeedMeeting {
  title: string;
  /** Minutes before "now" that the meeting happened, so the list looks lived-in. */
  daysAgo: number;
  durationSeconds: number;
  language: string;
  /** Transcript lines with the offset they start at, in seconds. */
  lines: { at: number; text: string }[];
}

const SEED_MEETINGS: SeedMeeting[] = [
  {
    title: "Checkout incident postmortem",
    daysAgo: 1,
    durationSeconds: 812,
    language: "English",
    lines: [
      { at: 0, text: "Alright everyone, thanks for joining. This is the postmortem for the checkout outage on Tuesday, so let's be blameless and just go through the timeline." },
      { at: 14, text: "I'll start with the impact. From 09:12 to 11:47 we had a partial outage, so roughly two and a half hours where a significant share of carts failed to complete. We estimate about forty thousand failed checkouts." },
      { at: 30, text: "That's higher than I expected. Was there any revenue impact beyond the lost carts?" },
      { at: 37, text: "Finance put it at around one point one million in gross merchandise value, but that's the direct figure only. Some of those customers came back the next day, so the true net is probably lower." },
      { at: 52, text: "Okay. So what actually caused it? Priya, you were on call." },
      { at: 57, text: "So we shipped the new pricing service version on Monday night. It was a routine deploy, config change to move tax calculation to the new rules engine. The health checks all passed." },
      { at: 71, text: "The problem was that the new service returned a 200 with an empty body instead of a 500 when the rules engine timed out. So our monitoring saw healthy traffic while every request was actually failing downstream." },
      { at: 88, text: "That's the real finding though, right? The alerts were green the entire time." },
      { at: 93, text: "Exactly. The dashboard we watched measured HTTP status codes only. It never checked whether the response body was actually usable." },
      { at: 103, text: "So we have three contributing factors. One, the new service returns a misleading status code on internal failure. Two, our alerting only tracks status codes and not payload validity. Three, we had no synthetic checkout test running against production." },
      { at: 124, text: "Can I add a fourth? The runbook for the pricing service was out of date. The on-call rotation was paged correctly but the first person who acknowledged spent eleven minutes trying to find the right dashboard." },
      { at: 138, text: "That's fair, so let's add that. Four contributing factors." },
      { at: 144, text: "So what are we deciding today? I want to be clear about what we actually commit to." },
      { at: 151, text: "Three things. First, we add a synthetic checkout transaction that runs every five minutes against production and alerts if it doesn't complete. Second, we add payload validation to the pricing service so downstream timeouts surface as a real 5xx. Third, we rewrite the pricing service runbook." },
      { at: 170, text: "Do we have a date on the synthetic test? That feels like the highest value one." },
      { at: 176, text: "I can have the basic version running by Thursday. It doesn't need to be a full checkout, just a pricing call that asserts a non-empty body." },
      { at: 187, text: "Thursday works. Priya, the payload fix, can you commit to a date?" },
      { at: 193, text: "End of next week. It's not just the status code, we need to decide whether the rules engine timeout should retry inside the service or bubble up. I'd rather not guess without the new team knowing the timeout budget." },
      { at: 207, text: "Fair. Then let's say the decision on retry behaviour is due end of next week, not the fix itself. And the runbook, who's taking that?" },
      { at: 218, text: "I'll do the runbook. I'm the secondary on call this rotation so I felt that eleven minutes personally." },
      { at: 225, text: "Good. So to summarise the actions. Priya, synthetic checkout by Thursday, and a decision on retry behaviour by end of next week. Sam, runbook rewrite, let's say by next Wednesday. And I'll take the retro of this whole thing with the platform team next week." },
      { at: 248, text: "Do we need to notify customers? Support has been asking." },
      { at: 253, text: "Support already sent a status page update on Tuesday, so we're covered there. What they want is a written explanation they can point at, which is basically this document." },
      { at: 265, text: "Then let's make sure the final version of this postmortem gets shared with support once it's written up. Last thing, is there anything anyone wants to raise before we close?" },
      { at: 276, text: "One ask. Can we stop treating 200 as meaning healthy across the board? I don't think the pricing service is the only place we do that." },
      { at: 288, text: "Agreed, that's out of scope for today but it's a real pattern. I'll add it to the platform team's list." },
      { at: 295, text: "Good. I think we're done. Thanks everyone." },
    ],
  },
  {
    title: "Staff engineer interview debrief",
    daysAgo: 3,
    durationSeconds: 594,
    language: "English",
    lines: [
      { at: 0, text: "Right, let's get through this debrief. Candidate was Priya Raman, for the staff engineer role, and we had four interviewers." },
      { at: 11, text: "Let me just run through the scores before we discuss, so nobody anchors. Design and architecture was a strong hire. Coding was a hire. Systems thinking was a strong hire. And the values interview was a no hire." },
      { at: 28, text: "Okay, let's take those one at a time. Start with the values one, since that's the one we disagree on." },
      { at: 35, text: "So the concern was the system design question. She proposed sharding the primary store by tenant, and when I pushed on what happens during a shard rebalance, she said you'd take a maintenance window." },
      { at: 50, text: "That was the flag. Taking a maintenance window on a customer facing primary store is a real operational decision and she'd present it as the default answer." },
      { at: 61, text: "I don't agree that it was a flag, and I want to be on the record. The prompt was deliberately underspecified, and given twenty minutes she said the first thing that came to mind and then explored it. That's arguably the right behaviour. You don't want a staff engineer who reaches for the clever answer first." },
      { at: 80, text: "But she never came back to it. When I asked what she'd do if she couldn't get the window, she said she'd tell the customer and move on. She didn't explore online migration at all." },
      { at: 93, text: "Right, but that's a design question you could solve in a week. I'm voting strong hire on the strength of the architecture and systems thinking scores, which were both excellent." },
      { at: 106, text: "Let me add something to the other side. On the coding exercise she wrote the cleanest distributed counter I've seen from a candidate. Real clarity, and she explained her tradeoffs without being asked." },
      { at: 120, text: "That's fair, that was genuinely excellent work." },
      { at: 124, text: "So where does that leave us? We've got three strong hires and one no hire." },
      { at: 131, text: "The debrief process says we need consensus. Do we have a path to consensus or is this going to be a no?" },
      { at: 139, text: "I'll go along with strong hire. My hesitation was about the maintenance window comment, and I think I overweighted it against three very strong signals." },
      { at: 152, text: "Alright, so let's call it. Four votes, three strong hire, one no hire, and the discussion is now consensus strong hire. That's the decision." },
      { at: 166, text: "Can we agree on the feedback we give her? I don't want the values interviewer to send something that reads as an invitation to argue." },
      { at: 178, text: "I'll write the feedback. The honest version is that she was strong and we had one disagreement about how she approached the operational tradeoff, and we resolved it as a hire." },
      { at: 190, text: "Thanks for doing that. What about timing? The team is waiting on this to close the req." },
      { at: 198, text: "Can we make an offer this week? Her competing process closes on Friday and I'd rather not lose her to a process that moves faster." },
      { at: 208, text: "I'll ask recruiting to start the offer paperwork today. We can have a draft comp package by tomorrow for the hiring manager to review." },
      { at: 220, text: "Works for me. Anything else before we finish? No. Thanks everyone." },
    ],
  },
  {
    title: "Sprint 42 planning",
    daysAgo: 5,
    durationSeconds: 1043,
    language: "English",
    lines: [
      { at: 0, text: "Let's start sprint 42 planning. We've got eleven working days and I'd like to talk about capacity first, then the backlog." },
      { at: 12, text: "Capacity wise, I have four engineers at full allocation. Maya's out the first three days for a conference, so call it three and a half, and Dave is splitting with the platform team so he's half a person here." },
      { at: 27, text: "So that's four and a half engineers, roughly, over eleven days. Last sprint we committed to nine points and delivered six, so let's not get ambitious." },
      { at: 40, text: "Can I say what happened to the three points we didn't finish? Two of them were the search rewrite, which got blocked on the index migration, and the third was the settings bug that turned out to be a one line fix that sat in review for four days." },
      { at: 57, text: "The review delay is the one to talk about. Who's reviewing on checkout?" },
      { at: 62, text: "Me, mostly. And I was on the incident last week, so that's on me. I can commit to reviewing same day from now on." },
      { at: 72, text: "Let's make it a team norm rather than a personal fix. Two-person rule on anything over a day's work, and anything under a day gets reviewed within twenty four hours." },
      { at: 84, text: "I'll write that into the contributing guide. Agreed?" },
      { at: 88, text: "Agreed." },
      { at: 90, text: "Now the backlog. The three things everyone keeps asking for are the settings bug, finishing the search rewrite, and the export to CSV feature." },
      { at: 101, text: "The settings bug is a day of work and it's embarrassing that it's still open, so that should definitely be in." },
      { at: 110, text: "Search rewrite is the big one. Blocked on the index migration, and the migration is owned by the platform team." },
      { at: 121, text: "I can pick up the index migration, but it's not a two day job. Call it four days." },
      { at: 128, text: "So search rewrite is realistically four days of migration plus the rewrite itself, which was another five. That's most of the sprint for one ticket." },
      { at: 138, text: "Then we don't do the whole rewrite. Let's do the migration and ship the two highest value search fixes behind a flag, and schedule the rest of the rewrite for sprint 43." },
      { at: 152, text: "Which two fixes? The typo tolerance and the ranking on recency are the two people actually complain about. Faceted filtering has had no requests." },
      { at: 164, text: "Then that's the scope. Typo tolerance and recency ranking. And we agree to schedule the full rewrite for sprint 43 so it doesn't keep slipping." },
      { at: 175, text: "One consequence: if the migration lands in sprint 42 and the rewrite waits until 43, we're paying for the index change with no user-visible benefit for a sprint. Is that acceptable?" },
      { at: 188, text: "It's a bit awkward but yes, because the migration is the thing that's blocked us twice now. And it unblocks the platform team's queue too, which we've wanted for a while." },
      { at: 199, text: "Fine. Then what about export to CSV? That's the feature sales keeps promising." },
      { at: 207, text: "Export is four days and it touches the permissions layer, which we don't want to be changing during an index migration. I don't think we can do it this sprint." },
      { at: 217, text: "So it's a no for sprint 42, and someone needs to tell sales before they put it in a customer deck." },
      { at: 227, text: "I'll handle that. I have the sales sync Thursday." },
      { at: 232, text: "Right, so let me read back the sprint. Settings bug, one day. Index migration, four days. Search typo tolerance and recency ranking behind a flag. Full search rewrite moves to sprint 43. Export to CSV deferred with sales told this week. Two day review turnaround as a team norm." },
      { at: 256, text: "That's nine points by my count, which is what we committed to last sprint and didn't finish." },
      { at: 265, text: "Given the reduced capacity though, I'd rather commit to seven and keep the buffer. I'd rather under commit and have a good sprint." },
      { at: 276, text: "Agreed. Seven points. Who wants what?" },
      { at: 281, text: "I'll take the settings bug and the typo tolerance work. That should be me and one of the juniors for the first three days." },
      { at: 292, text: "I'll do the index migration, starting tomorrow once I finish the platform handover." },
      { at: 299, text: "I'll do the recency ranking and then pick up review." },
      { at: 304, text: "Good. Any risks we should flag? The only real risk is the index migration, since everything on search depends on it. If that slips we should kill the search work rather than start it on an unstable index." },
      { at: 318, text: "Agreed on that. So sprint 42 planning is done. Let's do the retro on Friday." },
    ],
  },
  {
    title: "Q4 roadmap sync with sales",
    daysAgo: 8,
    durationSeconds: 726,
    language: "English",
    lines: [
      { at: 0, text: "This is the quarterly roadmap sync with the sales team. Goal is to leave with agreement on what we're actually committing to in Q4, and what we're explicitly not doing." },
      { at: 15, text: "Let me frame it. We have three teams, so three sprints of work each, and honestly I'd rather commit to two things that ship than five things that don't. So push back if that's too conservative." },
      { at: 30, text: "What are the candidates? From our side the three biggest are SSO with SAML, the reporting dashboard, and bulk editing on the contacts table." },
      { at: 43, text: "SSO is the one that keeps coming up. I had two enterprise deals last quarter that stalled specifically because we didn't have SAML. One of them went to a competitor." },
      { at: 57, text: "How big is it, really? We have OAuth already, and I want to know if SAML is weeks or months." },
      { at: 66, text: "It's not trivial. The library handles the protocol but the entity ID and certificate mapping per tenant is genuinely fiddly, and enterprise customers will absolutely test the failure paths. I'd estimate five weeks with one engineer, and I don't want to under-promise here." },
      { at: 82, text: "Five weeks out of three sprints means it consumes most of a team. Is that the best use of it?" },
      { at: 90, text: "I think yes, because it's the only item on this list that has closed deals. The other two are nice to have." },
      { at: 98, text: "I'd push back slightly. Reporting is what keeps the mid-market churn. We lost two accounts last quarter citing that they couldn't get data out." },
      { at: 108, text: "How many accounts is that, and what did they say they'd need? Not a dashboard, specifically?" },
      { at: 116, text: "One wanted scheduled email reports, one wanted a CSV of a custom segment. Both things are smaller than the dashboard we've been imagining." },
      { at: 127, text: "So maybe the honest version of reporting is two small features rather than one big dashboard. That's a different conversation and I'd want to scope it separately." },
      { at: 138, text: "I agree. So let's not commit to the dashboard, and instead commit to scoping it properly." },
      { at: 146, text: "That works. What's the scope deliverable? A written spec with an estimate, reviewed by both of us?" },
      { at: 155, text: "Yes. And I want a customer call in there, because we're guessing at what they need. We can use the two accounts that churned as referrals." },
      { at: 166, text: "I can make those two calls, I have the relationships. Give me a week and I'll have notes from both." },
      { at: 175, text: "Then I'll have the spec drafted the week after. So that's a real deliverable in Q4, just not the feature." },
      { at: 184, text: "Which leaves bulk editing. Be honest with me, is that ever getting built?" },
      { at: 191, text: "Bulk editing has been on the list for four quarters, so the honest answer is no, not in Q4. Every time we've scheduled it, something more urgent has displaced it." },
      { at: 204, text: "Then let's take it off the roadmap entirely rather than carrying it as a maybe. Carrying it means people keep asking when." },
      { at: 213, text: "Agreed. Take it off. If the reporting scope turns up something that includes a bulk operation, it can come back through that." },
      { at: 222, text: "So the decision is: SSO with SAML is the committed Q4 feature, owned by one engineer, targeting end of quarter. Reporting gets scoped properly with two customer calls and a written estimate. Bulk editing is explicitly off the roadmap for Q4." },
      { at: 240, text: "End of quarter is tight for five weeks of work. Can we agree on a mid-quarter checkpoint where if it's not half done we descope?" },
      { at: 252, text: "Yes, let's do that. Mid-quarter checkpoint, and if SAML isn't at the point where the happy path works against our test tenant, we stop and talk rather than push the date." },
      { at: 266, text: "I can live with that. And what do I tell the two accounts that are waiting on this?" },
      { at: 273, text: "Tell them it's committed for this quarter. That's a real date they can plan around, and it's the first time we've been able to say that about any roadmap item in a while." },
      { at: 286, text: "That is a nice change. Anything else?" },
      { at: 290, text: "One ask from me, and it's a process thing. Can we do this sync every two weeks instead of quarterly? Quarterly is too long a gap to catch drift." },
      { at: 301, text: "Every two weeks is a lot of meetings for a three team org. What about monthly?" },
      { at: 309, text: "Monthly works. I'll set it up recurring." },
    ],
  },
];

function buildSegments(meeting: SeedMeeting) {
  return meeting.lines.map((line, index) => {
    const next = meeting.lines[index + 1];
    // Whisper segments never run to the exact next start; leaving a small gap
    // keeps the generated timings consistent with real output.
    const end = next ? Math.max(line.at + 1, next.at - 0.4) : meeting.durationSeconds;
    return { start: line.at, end, text: line.text };
  });
}

function buildTranscript(meeting: SeedMeeting): string {
  return meeting.lines.map((line) => line.text).join(" ");
}

function daysAgoIso(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  // Nudge back to a plausible working hour rather than whatever time it is now.
  date.setHours(10 + (days % 6), 15, 0, 0);
  return date.toISOString();
}

async function clearPreviousSeeds() {
  const client = await db();
  const result = await client.execute(
    "DELETE FROM meetings WHERE source = 'seed'",
  );
  return Number(result.rowsAffected ?? 0);
}

async function main() {
  if (!process.env.GROQ_API_KEY) {
    console.error(
      "GROQ_API_KEY is not set. Run with: npm run db:seed --env-file=.env.local",
    );
    process.exit(1);
  }

  const removed = await clearPreviousSeeds();
  if (removed > 0) {
    console.log(`Removed ${removed} previously seeded meeting(s).`);
  }

  for (const seed of SEED_MEETINGS) {
    const segments = buildSegments(seed);
    const transcript = buildTranscript(seed);

    const meeting = await createMeeting({
      title: seed.title,
      source: "seed",
      audioFilename: null,
      audioMime: null,
      audioBytes: null,
      durationSeconds: seed.durationSeconds,
    });

    const client = await db();
    await client.execute({
      sql: `UPDATE meetings
               SET transcript = ?, transcript_language = ?,
                   transcript_segments_json = ?, created_at = ?, updated_at = ?
             WHERE id = ?`,
      args: [
        transcript,
        seed.language,
        JSON.stringify(segments),
        daysAgoIso(seed.daysAgo),
        daysAgoIso(seed.daysAgo),
        meeting.id,
      ],
    });

    process.stdout.write(`Summarising "${seed.title}"... `);
    try {
      const summary: MeetingSummary = await summarizeMeeting(meeting.id);
      console.log(
        `ok (${summary.topics.length} topics, ${summary.decisions.length} decisions, ` +
          `${summary.action_items.length} action items, ${summary.key_moments.length} key moments)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await setStatus(meeting.id, "failed", message);
      console.log(`FAILED: ${message}`);
    }
  }

  console.log("Seed complete.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
