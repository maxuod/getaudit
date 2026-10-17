import React, { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { t, useUiLanguage } from './i18n.tsx';
import { loadingPhaseMessages, loadingStateMessages } from './locales/loading.ts';
import { DotHelper } from './dot-helper.tsx';

const phaseIds = ['entry', 'citations', 'records'] as const;
type Phase = typeof phaseIds[number];
export function LoadingHelper({ phase = 'entry', active, title, detail, compact = false }: { phase?: Phase; active: boolean; title?: string; detail?: string; compact?: boolean }) {
  useUiLanguage();
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const root = useRef<HTMLDivElement>(null);
  const elapsed = useRef(0);
  const phaseIndex = phaseIds.indexOf(phase);
  const messages = loadingPhaseMessages[phase];
  useEffect(() => { elapsed.current = 0; setIndex(0); }, [phase]);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    let onScreen = true;
    const update = () => setVisible(onScreen && !document.hidden);
    const observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => { onScreen = entries[0].isIntersecting; update(); }) : undefined;
    if (root.current) observer?.observe(root.current);
    document.addEventListener('visibilitychange', update); update();
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, []);
  useEffect(() => {
    if (!active || !visible || reduced) return;
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now(); elapsed.current += now - last; last = now;
      if (elapsed.current >= 6500) { elapsed.current %= 6500; setIndex(value => (value + 1) % messages.length); }
    }, 200);
    return () => window.clearInterval(timer);
  }, [active, visible, reduced, phase, messages.length]);
  const phaseLabels = [t("loading.checkEntryPoints"), t("loading.matchCitations"), t("loading.organizeRecords")];
  const message = active ? messages[index % messages.length] : loadingStateMessages.waiting[0];
  return <div ref={root} className={'loading-helper' + (compact ? ' compact' : '')} data-active={active && visible && !reduced} data-phase={phase} aria-busy={active}>
    <div className="helper-status"><span className="helper-activity" aria-hidden="true" /><strong>{title ?? (active ? t("loading.aLittleDeskWorkInProgress") : t("loading.pausedHere"))}</strong></div>
    {!compact && <ol className="helper-phases" aria-label={t("loading.currentTaskStage")}>
      {phaseLabels.map((label, position) => <li key={phaseIds[position]} className={position === phaseIndex ? 'active' : position < phaseIndex ? 'done' : ''} aria-current={position === phaseIndex ? 'step' : undefined}>{position < phaseIndex ? <Check size={14} aria-hidden="true" /> : <span>{position + 1}</span>}{label}</li>)}
    </ol>}
    <div className="helper-companion"><DotHelper phase={phase} moving={active && visible && !reduced} compact={compact} /><p aria-live="off">{t(message)}</p></div>
    <div className="helper-track" aria-hidden="true"><span /></div>
    {detail && <p className="helper-detail">{detail}</p>}
  </div>;
}
