// Project contact is public. Review the example deployment facts before publication.
export const siteConfig = Object.freeze({
  origin: 'https://example.com',
  publicIndexing: false,
  productName: 'getaudit',
  wordmark: 'getaudit.si',
  contributorLabel: 'getaudit contributors',
  contactEmail: 'deeyoung_ma@maxuod.com',
  privacyIsTemplate: true,
});

export function configureContent(value) {
  if (Array.isArray(value)) return value.map(configureContent);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, configureContent(item)]));
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{(contributorLabel|contactEmail|origin)\}\}/g, (_, key) => siteConfig[key]);
}
