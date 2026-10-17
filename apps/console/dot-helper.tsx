import React from 'react';
import evidenceCloudUrl from './assets/getaudit-evidence-cloud.png';
import './dot-helper.css';

/** A decorative companion. Task state and progress belong to the parent helper. */
export function DotHelper({ phase = 'entry', moving = false, compact = false }: { phase?: 'entry' | 'citations' | 'records'; moving?: boolean; compact?: boolean }) {
  return <span className={'dot-helper' + (compact ? ' dot-helper--compact' : '')} data-motion={moving} data-phase={phase} aria-hidden="true">
    <img className="dot-helper__image" src={evidenceCloudUrl} width={1536} height={1024} alt="" draggable={false} decoding="async" />
  </span>;
}
