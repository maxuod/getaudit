import React from 'react';
import './dot-helper.css';

/** A decorative companion. Task state and progress belong to the parent helper. */
export function DotHelper({ phase = 'entry', moving = false, compact = false }: { phase?: 'entry' | 'citations' | 'records'; moving?: boolean; compact?: boolean }) {
  return <span className={'dot-helper' + (compact ? ' dot-helper--compact' : '')} data-motion={moving} data-phase={phase} aria-hidden="true">
    <span className="dot-helper__scene">
    <span className="dot-helper__shadow" />
    <span className="dot-helper__paper"><span /><span /><span /></span>
    <span className="dot-helper__body"><span className="dot-helper__eyes"><span /><span /></span><span className="dot-helper__cheek" /></span>
    <span className="dot-helper__lens" />
    </span>
  </span>;
}
