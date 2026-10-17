import { translateMessage, type MessageLanguage } from './locales/format.ts';

const localTemplate = /^(?:Locally collected questions|本地采集问题) · (\d{4}-\d{2}-\d{2})$/;
const gscTemplate = /^GSC candidate questions · (\d{4}-\d{2}-\d{2})$/;

/** Adapt known generated display names only. Saved names and evidence stay untouched. */
export function displayQuestionSetLabel(original: string, language: MessageLanguage): string {
  const local = localTemplate.exec(original);
  const gsc = gscTemplate.exec(original);
  const date = (local ?? gsc)?.[1];
  if (!date) return original;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return original;
  return translateMessage(language, local ? 'questionSetLabel.locallyCollected' : 'questionSetLabel.gscCandidates', { date });
}
