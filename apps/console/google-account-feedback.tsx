import React from 'react';
import { t, type SimpleMessageKey } from './i18n.tsx';
import type { GoogleAccountErrorDetail as BackendErrorDetail, GoogleAccountErrorPhase as BackendErrorPhase } from '../../src/console/google-account.ts';

const detailKeys = {
  client_secret_missing: 'google.auth.clientSecretMissing',
  invalid_client: 'google.auth.invalidClient',
  invalid_grant: 'google.auth.invalidGrant',
  invalid_request: 'google.auth.invalidRequest',
  unauthorized_client: 'google.auth.unauthorizedClient',
  redirect_uri_mismatch: 'google.auth.redirectMismatch',
  invalid_scope: 'google.auth.invalidScope',
  access_denied: 'google.accessDenied',
  temporarily_unavailable: 'google.auth.temporarilyUnavailable',
  provider_request_failed: 'google.auth.providerRequestFailed',
  provider_response_invalid: 'google.auth.providerResponseInvalid',
  id_token_missing: 'google.auth.identityMissing',
  id_token_signature_invalid: 'google.auth.identitySignatureInvalid',
  id_token_claims_invalid: 'google.auth.identityClaimsInvalid',
  id_token_nonce_mismatch: 'google.auth.identityRequestMismatch',
  provider_keys_unavailable: 'google.auth.verificationKeysUnavailable',
  encrypted_storage_write_failed: 'google.auth.secureSaveFailed',
  callback_expired: 'google.auth.callbackExpired',
  callback_invalid: 'google.auth.callbackInvalid',
  configuration_missing: 'google.ownerSetupRequired',
} as const satisfies Record<BackendErrorDetail, SimpleMessageKey>;
const phaseKeys = {
  configuration: 'google.auth.phaseConfiguration',
  authorization: 'google.auth.phaseAuthorization',
  callback: 'google.auth.phaseCallback',
  token_exchange: 'google.auth.phaseApproval',
  identity_verification: 'google.auth.phaseIdentity',
  secure_storage: 'google.auth.phaseStorage',
  refresh: 'google.auth.phaseRefresh',
} as const satisfies Record<BackendErrorPhase, SimpleMessageKey>;
const codeKeys = {
  setup_required: 'google.ownerSetupRequired', access_denied: 'google.accessDenied',
  expired: 'google.auth.callbackExpired', cancelled: 'google.auth.cancelled',
  verification_failed: 'google.auth.verificationFailed', storage_unavailable: 'google.storageLocked',
  unavailable: 'google.auth.providerRequestFailed',
} as const satisfies Record<string, SimpleMessageKey>;

export type GoogleAccountErrorDetail = keyof typeof detailKeys;
export type GoogleAccountErrorPhase = keyof typeof phaseKeys;
type FeedbackState = { status?: unknown; errorCode?: unknown; errorDetail?: unknown; errorPhase?: unknown };
function known<Key extends string>(keys: Record<Key, unknown>, value: unknown): value is Key { return typeof value === 'string' && Object.hasOwn(keys, value); }

/** Only authored, whitelisted diagnostics are rendered. Provider text and identity data never enter this view. */
export function googleAccountFeedback(account: FeedbackState | null | undefined) {
  if (account?.status !== 'error') return null;
  const detail = known(detailKeys, account.errorDetail) ? account.errorDetail : null;
  const code = known(codeKeys, account.errorCode) ? account.errorCode : null;
  const phase = known(phaseKeys, account.errorPhase) ? account.errorPhase : null;
  return {
    message: t(detail ? detailKeys[detail] : code ? codeKeys[code] : 'google.connectionFailed'),
    phase: phase ? t(phaseKeys[phase]) : null,
    code: detail ?? code,
  };
}

export function GoogleAccountFeedback({ account, className = '' }: { account: FeedbackState; className?: string }) {
  const feedback = googleAccountFeedback(account);
  if (!feedback) return null;
  return <div className={'google-account-feedback ' + className} role="alert"><p>{feedback.message}</p>{(feedback.phase || feedback.code) && <details><summary>{t('google.auth.connectionDetails')}</summary><dl>{feedback.phase && <><dt>{t('google.auth.step')}</dt><dd>{feedback.phase}</dd></>}{feedback.code && <><dt>{t('google.auth.diagnosticCode')}</dt><dd><code>{feedback.code}</code></dd></>}</dl></details>}</div>;
}
