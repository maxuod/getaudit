import React, {useEffect, useState} from "react";
import {RefreshCw, ShieldCheck} from "lucide-react";
import {request} from "./api.ts";
import {t, uiMessage, useUiLanguage} from "./i18n.tsx";
import type {BrowserJobs} from "../../src/console/browser-jobs.ts";
import type {LabService} from "../../src/console/service.ts";
import "./guest-readiness.css";

type Readiness = ReturnType<BrowserJobs["guestReadiness"]>;
export function GuestReadiness({plan, samplingActive, available}: {
  plan: ReturnType<LabService["plan"]>; samplingActive: boolean; available: boolean;
}) {
  const language = useUiLanguage();
  const [data, setData] = useState<Readiness | null>(null);
  const [checking, setChecking] = useState<string | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setData(null); setError("");
    request<Readiness>("browser-guest-readiness?id=" + plan.id)
      .then(value => {if (live) setData(value);})
      .catch(cause => {if (live) setError(cause.message);});
    return () => {live = false;};
  }, [plan.id, samplingActive]);
  useEffect(() => {
    if (!data?.inspectionActive) return;
    let live = true;
    const timer = window.setTimeout(() => {
      request<Readiness>("browser-guest-readiness?id=" + plan.id)
        .then(value => {if (live) setData(value);})
        .catch(cause => {if (live) setError(cause.message);});
    }, 1500);
    return () => {live = false; window.clearTimeout(timer);};
  }, [data, plan.id]);
  async function inspect(surface: string) {
    const id = plan.id;
    setChecking(surface); setError("");
    try {
      const value = await request<Readiness>("browser-guest-readiness", {planId: id, surface, browserMode: "silent"});
      setData(value);
    } catch (cause) {setError(cause instanceof Error ? cause.message : t("feedback.theActionCouldNotBeCompleted"));}
    finally {setChecking(null);}
  }
  return <section className="guest-readiness" aria-labelledby="guest-heading" aria-busy={!!checking}>
    <div className="guest-heading"><ShieldCheck size={20} aria-hidden="true"/><div>
      <h3 id="guest-heading">{t("guest.title")}</h3><p className="muted">{t("guest.strictModeHint")}</p>
    </div></div>
    <p className="quiet-note">{t("guest.entryCheckHint")}</p>
    {!available && <p role="status">{t("guest.collectorUnavailable")}</p>}
    {samplingActive && <p role="status">{t("guest.pauseBeforeChecking")}</p>}
    {data?.inspectionActive && !checking && <p role="status">{t("guest.finishingCheck")}</p>}
    {data?.platforms.map(platform => {
      const check = platform.latest;
      const label = !check ? t("guest.notChecked") : check.status === "ready" ? t("guest.entryAvailable") : check.status === "restricted" ? t("guest.restricted") : t("guest.unknown");
      return <div className="guest-row" key={platform.surface}>
        <div><strong>{platform.name}</strong><span className={`tag ${check?.status === "ready" ? "success" : check?.status === "restricted" ? "warning" : ""}`}>{label}</span></div>
        <div className="guest-details">
          {check ? <><p>{uiMessage(check.reason)}</p><small className="muted">{t("guest.checkedAt", {time: new Date(check.checkedAt).toLocaleString(language)})}</small><small className="muted">{check.browserMode==='silent'?t("background.entryMode"):check.browserMode==='visible'?t("background.visibleEntryHistory"):t("background.entryModeUnknown")}</small></> : <p className="muted">{t("guest.noCurrentEvidence")}</p>}
          {platform.restriction.active && <small className="guest-stop">{t("guest.historicalStopRetained")}</small>}
        </div>
        <button disabled={!available || samplingActive || !!checking || !platform.canCheck} onClick={() => void inspect(platform.surface)}>
          <RefreshCw size={15} aria-hidden="true"/>{checking === platform.surface ? t("guest.checking") : t("guest.checkEntry")}
        </button>
      </div>;
    })}
    {error && <p className="alert error" role="alert">{uiMessage(error)}</p>}
    <small className="muted" role="status">{t("guest.resultsUntested")}</small>
  </section>;
}
