import { z } from "zod";
export const connectionFields = [
  { key: "GETGEO_GOOGLE_CLIENT_ID", label: "Google sign-in · Desktop OAuth Client ID", secret: false },
  { key: "GETGEO_GOOGLE_CLIENT_SECRET", label: "Google sign-in · Desktop OAuth Client Secret (optional)", secret: true },
  { key: "GSC_MCP_KEY", label: "GSC MCP 独立只读密钥", secret: true },
  { key: "GSC_CLIENT_ID", label: "GSC OAuth Client ID", secret: false },
  { key: "GSC_CLIENT_SECRET", label: "GSC OAuth Client Secret", secret: true },
  { key: "GSC_REFRESH_TOKEN", label: "GSC 只读 Refresh Token", secret: true },
  { key: "OPENAI_API_KEY", label: "OpenAI API Key", secret: true },
  { key: "OPENAI_MODEL", label: "OpenAI 模型 ID", secret: false },
  { key: "SEO_AUDIT_OPENAI_MODEL", label: "关键词审计 · OpenAI 模型（默认 gpt-6.1-sol）", secret: false },
  { key: "GOOGLE_AI_API_KEY", label: "Google AI API Key", secret: true },
  { key: "GOOGLE_AI_MODEL", label: "Gemini 模型 ID", secret: false },
  { key: "ANTHROPIC_API_KEY", label: "Anthropic API Key", secret: true },
  { key: "ANTHROPIC_MODEL", label: "Claude 模型 ID", secret: false },
  { key: "SEO_AUDIT_ANTHROPIC_MODEL", label: "关键词审计 · Claude 模型（默认 claude-sonnet-5-5）", secret: false },
  { key: "PERPLEXITY_API_KEY", label: "Perplexity API Key", secret: true },
  { key: "PERPLEXITY_MODEL", label: "Perplexity 模型 ID", secret: false },
  { key: "DATAFORSEO_LOGIN", label: "DataForSEO Login", secret: true },
  { key: "DATAFORSEO_PASSWORD", label: "DataForSEO Password", secret: true },
  {
    key: "DATAFORSEO_CHATGPT_MODEL",
    label: "DataForSEO ChatGPT 模型 ID",
    secret: false,
  },
  {
    key: "DATAFORSEO_GEMINI_MODEL",
    label: "DataForSEO Gemini 模型 ID",
    secret: false,
  },
  {
    key: "DATAFORSEO_CLAUDE_MODEL",
    label: "DataForSEO Claude 模型 ID",
    secret: false,
  },
] as const;
// The account session is encrypted alongside connections, never exposed as a form field.
export const storageFields = [...connectionFields,
  {key:'GETGEO_GOOGLE_ACCOUNT_SESSION',label:'Internal Google account session',secret:true,maxLength:32768},
  {key:'GETAUDIT_GOOGLE_DATA_SUBJECT',label:'Internal Google connection owner',secret:true,maxLength:256},
  {key:'GETAUDIT_GOOGLE_DATA_MODE',label:'Internal Google connection mode',secret:false,maxLength:16},
] as const;
export type PersistSettings = (values: Record<string, string>) => void | Promise<void>;
// The environment is shared by all local requests. Read it only after earlier
// writes finish, so concurrent patches preserve each other's fields.
let settingsWrite: Promise<unknown> = Promise.resolve();
export async function configure(input: unknown, persist?: PersistSettings) {
  const v = z
    .record(z.string(), z.string().trim().min(1).max(2000))
    .parse(input);
  for (const key of Object.keys(v))
    if (!connectionFields.some((f) => f.key === key))
      throw new Error("不支持的连接字段");
  return writeSettings(v,persist);
}
export async function persistGoogleAccountSession(value:string|undefined,persist?:PersistSettings) {
  if(!persist)throw new Error('Google sign-in needs encrypted desktop storage.');
  if(value!==undefined&&(typeof value!=='string'||value.length>32768||!value.length))throw new Error('Invalid Google account session.');
  return writeSettings({GETGEO_GOOGLE_ACCOUNT_SESSION:value??'DELETE'},persist);
}
export async function persistGoogleDataSession(session:string,subject:string,persist?:PersistSettings) {
  if(!persist)throw new Error('Google connection needs encrypted desktop storage.');
  if(!session||session.length>32768||!subject||subject.length>256)throw new Error('Invalid Google data session.');
  return writeSettings({GETGEO_GOOGLE_ACCOUNT_SESSION:session,GETAUDIT_GOOGLE_DATA_SUBJECT:subject,GETAUDIT_GOOGLE_DATA_MODE:'managed'},persist);
}
export async function disconnectGoogleData(persist?:PersistSettings) {
  if(!persist)throw new Error('Google connection needs encrypted desktop storage.');
  const managed=process.env.GETAUDIT_GOOGLE_DATA_MODE==='managed'||!!process.env.GETAUDIT_GOOGLE_DATA_SUBJECT;
  return writeSettings({GETGEO_GOOGLE_ACCOUNT_SESSION:'DELETE',GETAUDIT_GOOGLE_DATA_SUBJECT:'DELETE',...(managed?{GETAUDIT_GOOGLE_DATA_MODE:'managed'}:{})},persist);
}
function writeSettings(v:Record<string,string>,persist?:PersistSettings) {
  const write = settingsWrite.then(async () => {
    const current = Object.fromEntries(
      storageFields
        .filter((f) => process.env[f.key])
        .map((f) => [f.key, process.env[f.key]!]),
    );
    const next = { ...current };
    for (const [k, value] of Object.entries(v)) {
      if (value === "DELETE") delete next[k];
      else next[k] = value;
    }
    // Saving an unchanged form should not unlock or rewrite encrypted storage.
    if (storageFields.every((f) => next[f.key] === current[f.key]))
      return { ok: true };
    await persist?.({ ...next });
    for (const f of storageFields) {
      if (next[f.key]) process.env[f.key] = next[f.key];
      else delete process.env[f.key];
    }
    return { ok: true };
  });
  // A failed save leaves the old environment intact and must not poison the
  // queue for the next request.
  settingsWrite = write.catch(() => undefined);
  return write;
}
