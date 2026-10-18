import React from 'react';
import {Building2,ChevronRight,Globe,Link2,ListChecks,FlaskConical} from 'lucide-react';
import {t,useUiLanguage} from './i18n.tsx';

export function WorkspaceSettings({projectCount,onNavigate,onConnections,onSearchSetup}:{projectCount:number;onNavigate:(page:string)=>void;onConnections:()=>void;onSearchSetup:()=>void}) {
  useUiLanguage();
  return <section className="workspace-settings" aria-label={t('simple.settings')}>
    <div className="settings-list">
      <button data-nav="brands" onClick={()=>onNavigate('brands')}><Building2 size={19}/><span><strong>{t('simple.projects')}</strong><small>{t('simple.projectsHint',{count:projectCount})}</small></span><ChevronRight size={16}/></button>
      <button data-nav="search-settings" onClick={onSearchSetup}><Globe size={19}/><span><strong>{t('google.navigation')}</strong><small>{t('google.settingsHint')}</small></span><ChevronRight size={16}/></button>
      <button data-nav="connections" onClick={onConnections}><Link2 size={19}/><span><strong>{t('simple.connections')}</strong><small>{t('simple.connectionsHint')}</small></span><ChevronRight size={16}/></button>
      <button data-nav="questions" onClick={()=>onNavigate('questions')}><ListChecks size={19}/><span><strong>{t('simple.questions')}</strong><small>{t('simple.questionsHint')}</small></span><ChevronRight size={16}/></button>
      <button data-nav="agents" onClick={()=>onNavigate('agents')}><Link2 size={19}/><span><strong>{t('simple.agentAccess')}</strong><small>{t('simple.agentAccessHint')}</small></span><ChevronRight size={16}/></button>
    </div>
    <p className="settings-privacy"><a href="https://getaudit.si/privacy/" target="_blank" rel="noopener noreferrer">{t('privacy.policyLink')}</a></p>
    <details className="simple-advanced"><summary>{t('simple.advancedTools')}</summary><div className="settings-list"><button data-nav="lab" onClick={()=>onNavigate('lab')}><FlaskConical size={19}/><span><strong>{t('simple.diagnostics')}</strong><small>{t('simple.diagnosticsHint')}</small></span><ChevronRight size={16}/></button></div></details>
    <p className="settings-local-note">{t('simple.backgroundHint')}</p>
  </section>;
}
