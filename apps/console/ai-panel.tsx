import {t, useUiLanguage, uiMessage} from './i18n.tsx';
import { useEffect, useState } from "react";
import type { AiAnalysis } from "../../src/console/ai-analysis.ts";
type Jobs = ReturnType<AiAnalysis["rows"]>;
type Preview = { preview: ReturnType<AiAnalysis["preview"]>; hash: string };
import {LoadingHelper} from './loading-helper.tsx';
import { request as call } from "./api.ts";
export function AiPanel({
  planId,
  openEvidence,
}: {
  planId: string;
  openEvidence: (slotId: string) => void;
}) {
  useUiLanguage();
  const [jobs, setJobs] = useState<Jobs>([]),
    [preview, setPreview] = useState<Preview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = async () => setJobs(await call<Jobs>("ai-jobs?id=" + planId));
  useEffect(() => {
    setPreview(null);
    setError("");
    refresh().catch((e) => setError(e.message));
  }, [planId]);
  useEffect(() => {
    if (!jobs.some((j) => j.status === "running")) return;
    const t = setInterval(
      () => refresh().catch((e) => setError(e.message)),
      2000,
    );
    return () => clearInterval(t);
  }, [jobs.some((j) => j.status === "running"), planId]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("ai.requestFailed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ai-panel">
      <div className="section-head">
        <div>
          <h2>{t("ai.aIInterpretationDraft")}</h2>
          <p className="muted">
             {t("ai.previewTheEvidenceBeforeSendingItEveryFindingMustIncludeAn")} </p>
        </div>
        <button
          disabled={busy}
          onClick={() =>
            action(async () =>
              setPreview(await call("ai-preview?id=" + planId)),
            )
          }
        >
           {t("ai.previewAnalysisMaterial")} </button>
      </div>
      {(busy||jobs.some(job=>job.status==='running'))&&<LoadingHelper compact active phase="records" title={jobs.some(job=>job.status==='running')?t("ai.generatingAnInterpretationDraft"):t("ai.completingTheRequestedStep")} detail={t("ai.yourRequestIsInProgressSavedEvidenceStaysUnchanged")}/>}
      {error && (
        <p className="alert error" role="alert">
          {uiMessage(error)}
        </p>
      )}
      {preview && (
        <form
          className="ai-preview"
          onSubmit={(e) => {
            e.preventDefault();
            action(async () => {
              await call("ai-jobs", {
                planId,
                previewHash: preview.hash,
                transmissionAcknowledged: true,
                costAcknowledged: true,
              });
              setPreview(null);
            });
          }}
        >
          <p>{t("ai.includedAnswersOfEligibleAnswersEligibleAnswersWithQuestionsEntryPointsAndSummaries", { includedAnswers: preview.preview.includedAnswers, eligibleAnswers: preview.preview.eligibleAnswers, excerptCharacters: preview.preview.excerptCharacters })}</p>
          <details>
            <summary>{t("ai.viewAllMaterialToBeSent")}</summary>
            <pre className="raw">
              {JSON.stringify(preview.preview, null, 2)}
            </pre>
          </details>
          <label className="check">
            <input type="checkbox" required />
             {t("ai.iHaveReviewedThisMaterialAndApproveSendingItToOpenAI")} </label>
          <p className="muted">
             {t("ai.usesYourConfiguredModelWithUpTo1800OutputTokens")} </p>
          <button
            className="primary"
            disabled={busy || !preview.preview.includedAnswers}
          >
             {t("ai.generateDraftForReview")} </button>
          <button type="button" onClick={() => setPreview(null)}>
             {t("common.cancel")} </button>
        </form>
      )}
      {jobs.map((job) => (
        <article className="ai-result" key={job.id}>
          <div className="button-row">
            <strong>{job.model}</strong>
            <span className="tag">
              {job.status === "draft"
                ? job.review
                  ? job.review.decision === "accept"
                    ? t("ai.interpretationAccepted")
                    : t("ai.returnedForRevision")
                  : t("ai.draftAwaitingReview")
                : job.status === "running"
                  ? t("ai.generating")
                  : job.status === "interrupted"
                    ? t("ai.interruptedNotResubmitted")
                    : t("ai.generationFailed")}
            </span>
          </div>
          <small>
            {job.created_at} · {t("ai.answersInAFixedSnapshotRunANewAnalysisIfConditions", { count: job.input.includedAnswers })} </small>
          {job.error && <p className="error-text">{uiMessage(job.error)}</p>}
          {job.result && (
            <>
              <p>{job.result.summary}</p>
              {job.result.findings.map((f, i) => (
                <div className="finding" key={i}>
                  <span className="tag">
                    {f.kind === "observation" ? t("ai.observation") : t("ai.hypothesisToVerify")}
                  </span>
                  <h3>{f.claim}</h3>
                  <p>{t("ai.nextStep")}{f.nextAction}</p>
                  {f.sources.map((s, k) => (
                    <blockquote key={k}>
                      <p>{s.quote}</p>
                      <button onClick={() => openEvidence(s.slotId)}>
                         {t("ai.viewOriginalEvidence")} </button>
                    </blockquote>
                  ))}
                </div>
              ))}
              {!job.review && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const form = new FormData(e.currentTarget);
                    action(() =>
                      call("ai-review", {
                        id: job.id,
                        decision: form.get("decision"),
                        note: form.get("note"),
                      }),
                    );
                  }}
                >
                  <label className="field">
                    <span>{t("ai.reviewDecision")}</span>
                    <select name="decision">
                      <option value="accept">{t("ai.acceptInterpretation")}</option>
                      <option value="reject">{t("ai.returnInterpretation")}</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>{t("ai.reviewNote")}</span>
                    <input name="note" required />
                  </label>
                  <button disabled={busy}>{t("ai.saveReview")}</button>
                </form>
              )}
            </>
          )}
        </article>
      ))}
    </section>
  );
}
