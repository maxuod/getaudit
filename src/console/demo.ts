import { randomUUID } from "node:crypto";
import type { LabService } from "./service.ts";
export function seedDemo(lab: LabService) {
  if ((lab.db.prepare("SELECT COUNT(*) n FROM brand").get() as { n: number }).n)
    return;
  const brand = lab.createBrand(randomUUID(), {
    name: "Northstar · Demo project",
    ownedDomains: ["northstar.example"],
    aliases: ["Northstar"],
    category: "Synthetic demo · Restaurant scheduling software",
  });
  const set = lab.createSet(randomUUID(), {
    brandId: brand.id,
    label: "Canadian restaurants · Buyer questions",
    locale: "en-CA",
    source: "Synthetic demo; not a real client or AI answer",
    kind: "hypothesis",
    prompts: [
      {
        text: "What scheduling software works for a small restaurant in Canada?",
        intent: "discovery",
      },
      {
        text: "How can restaurant managers reduce time spent on shift changes?",
        intent: "discovery",
      },
      {
        text: "What should I compare when choosing restaurant scheduling software?",
        intent: "discovery",
      },
    ],
  });
  lab.freeze(randomUUID(), set.id);
  const window = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Halifax",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const plan = lab.createPlan(randomUUID(), {
    promptSetId: set.id,
    label: "Anonymous surface comparison · Demo",
    surfaces: ["google_aio", "chatgpt_search"],
    windows: [window],
    country: "CA",
    locale: "en-CA",
    timezone: "America/Halifax",
    device: "desktop",
  });
  const slots = lab.plan(plan.id).slots;
  slots.slice(0, 4).forEach((s, i) => {
    const status =
      i === 2 && s.surface === "google_aio"
        ? "not_triggered"
        : i === 3
          ? "error"
          : "observed";
    const answer =
      status === "observed"
        ? "[Synthetic demo] Compare Northstar with other scheduling tools on shift swaps, staff availability, and manager approval. This is an example for testing evidence review, not a real AI answer."
        : "";
    const a = lab.capture(randomUUID(), {
      slotId: s.id,
      prompt: s.prompt,
      status,
      reason: status === "observed" ? "" : "Synthetic demo: feature absent or connection interrupted",
      restriction: "none",
      observedAt: new Date().toISOString(),
      answer,
      citations:
        status === "observed"
          ? [
              {
                url: "https://northstar.example/features",
                title: "Synthetic feature page",
              },
            ]
          : [],
      model: "unknown",
      account: "logged_out",
      session: "fresh",
      exitCountry: "CA",
      geo: "ip_observed",
      locale: "en-CA",
      timezone: "America/Halifax",
      device: "desktop",
      geolocation: "denied",
      searchMode: "explicit_search",
      collectionMode: "fixture",
      retrievalUsed: null,
      artifact: {
        mime: "text/plain",
        base64: Buffer.from(
          `[SYNTHETIC FIXTURE]\n${s.prompt}\n${answer || status}`,
        ).toString("base64"),
      },
    });
    if (i < 3)
      lab.review(randomUUID(), {
        attemptId: a.id,
        decision: "accept",
        note: "Synthetic demo evidence; not suitable for business conclusions",
        privacyReviewed: true,
      });
  });
}
