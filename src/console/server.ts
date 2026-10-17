import { GscConnector, gscMarkdown } from "./gsc.ts";
import {GscSync} from './gsc-sync.ts';
import {GscMcp,gscMcpVersions} from './gsc-mcp.ts';
import {GscSharing} from './gsc-sharing.ts';
import {shareReport} from './gsc-report.ts';
import {GscWorkspace} from './gsc-workspace.ts';
import {AgentMcp} from './agent-mcp.ts';
import {AgentAccessKeys} from './agent-access.ts';
import {GoogleAccount} from './google-account.ts';
import {googleClientConfig} from './google-client-config.ts';
import {Ga4Connector} from './ga4.ts';
import {GoogleDataWorkspace} from './google-data-workspace.ts';
import {LocalQuestions} from './local-questions.ts';
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { LabService } from "./service.ts";
import { createSnapshot } from "./snapshots.ts";
import {exportReportMarkdown} from './report.ts';
import {reportLocale} from './report-language.ts';
import {
  configure,
  connectionFields,
  persistGoogleAccountSession,
  persistGoogleDataSession,
  disconnectGoogleData,
  type PersistSettings,
} from "./settings.ts";
import {identifySources} from "./sources.ts";
import {answerMarkdown} from "./answer-markdown.ts";
import { surfaces } from "./contracts.ts";
import { z } from "zod";
import { AiAnalysis } from "./ai-analysis.ts";
import { KeywordAudit, keywordAuditLocations } from "./keyword-audit.ts";
import { canonicalJson, sha256 } from "../lib/canonical-json.ts";
import { ApiJobs } from "./api-jobs.ts";
import { BrowserJobs } from "./browser-jobs.ts";
import type { BrowserCollector } from "./browser-jobs.ts";
export async function serveConsole(
  service: LabService,
  options: {
    port?: number;
    fallbackPort?: boolean;
    autoGsc?: boolean;
    gscConnector?: GscConnector;
    ga4Connector?: Ga4Connector;
    keywordAuditFetcher?: typeof fetch;
    staticDir?: string;
    demo?: boolean;
    persistSettings?: PersistSettings;
    connectionAccess?: () => { status: 'loading' | 'ready' | 'locked'; message?: string };
    unlockConnections?: () => Promise<void>;
    openExternal?: (url:string) => void|Promise<void>;
    accountProvider?: Pick<GoogleAccount,'status'|'start'|'startGsc'|'ensureFresh'|'restore'|'signOut'|'dispose'> & Partial<Pick<GoogleAccount,'startData'|'dataToken'>>;
    canMutate?: () => boolean;
    browserCollector?: BrowserCollector;
    sampling?: {
      open: (task: {
        slotId: string;
        name: string;
        url: string;
        locale: string;
      }) => Promise<unknown>;
      capture: (slotId: string) => Promise<unknown>;
    };
  } = {},
) {
  let unifiedAttempt=false,dataStartRevision=0;
  const managedGoogle=()=>unifiedAttempt||process.env.GETAUDIT_GOOGLE_DATA_MODE==='managed';
  const googleContext=()=>{if(!managedGoogle())return 'legacy';const status=account.status();return JSON.stringify([status.status,status.profile?.subject,status.sessionRevision,Boolean(status.capabilities?.gsc)]);};
  const gsc = options.gscConnector ?? new GscConnector(service,undefined,undefined,async signal=>{
    if(!managedGoogle())return null;
    if(!account.dataToken)throw new Error('Reconnect Google to allow read-only Search Console access.');
    return account.dataToken('gsc',signal);
  },googleContext);
  const localQuestions=new LocalQuestions(service);
  const collectLocal=()=>{if(!options.canMutate||options.canMutate())localQuestions.collectAll();};
  collectLocal();
  const gscSync = new GscSync(service,gsc,Date.now,collectLocal,{
    canAutoRead:()=>{if(!managedGoogle())return ['GSC_CLIENT_ID','GSC_REFRESH_TOKEN'].every(key=>process.env[key]);const status=account.status();return status.status==='signed_in'&&status.capabilities?.gsc===true;},
    requireExplicitOptIn:managedGoogle,
  });
  const gscWorkspace=new GscWorkspace(service);
  const gscMcp=new GscMcp(gsc,gscWorkspace),gscSharing=new GscSharing(service,gsc);
  const jobs = new ApiJobs(service);
  const ai = new AiAnalysis(service);
  const keywordAudit = new KeywordAudit(service, gsc, options.keywordAuditFetcher);
  const agentMcp=new AgentMcp(service,gsc,gscWorkspace,keywordAudit),agentKeys=new AgentAccessKeys(service);
  const account=options.accountProvider??new GoogleAccount({
    config:()=>googleClientConfig(),
    readSession:()=>process.env.GETGEO_GOOGLE_ACCOUNT_SESSION,
    persistSession:value=>persistGoogleAccountSession(value,options.persistSettings).then(()=>{}),
    persistDataSession:(session,grant)=>persistGoogleDataSession(session,grant.profile.subject,options.persistSettings).then(()=>{}),
    onDisconnect:()=>disconnectGoogleData(options.persistSettings).then(()=>{}),
    onGscGrant:grant=>configure({GSC_CLIENT_ID:grant.clientId,GSC_CLIENT_SECRET:grant.clientSecret??'DELETE',GSC_REFRESH_TOKEN:grant.refreshToken},options.persistSettings).then(()=>{}),
  });
  const ga4=options.ga4Connector??new Ga4Connector({tokenProvider:async signal=>{
    if(!account.dataToken)throw new Error('Reconnect Google to allow read-only Analytics access.');
    return account.dataToken('ga4',signal);
  }});
  const googleData=new GoogleDataWorkspace(service,account,gsc,ga4);
  const dataStarts=new Map<string,{operation:Promise<{url:string;expiresAt:string;opened:boolean}>;expires:number}>();
  const browserJobs = new BrowserJobs(service, options.browserCollector);
  const token = randomBytes(32).toString("hex");
  const staticDir =
    options.staticDir ??
    fileURLToPath(new URL("../../dist/console", import.meta.url));
  let origin = "";
  let mcpKeyWrite: Promise<void> | undefined;
  const connectionAccess = () => {
    const access = options.connectionAccess?.();
    return access ? { status: access.status, ...(access.message ? { message: access.message } : {}) } : undefined;
  };
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.headers.host !== new URL(origin).host)
        return json({ error: "Host 不匹配" }, 403);
      if (req.headers.origin && req.headers.origin !== origin)
        return json({ error: "不允许跨站访问" }, 403);
      const url = new URL(req.url ?? "/", origin),
        path = url.pathname;
      if(path==='/agent/mcp'){
        if(options.canMutate&&!options.canMutate())return json({error:'The local ledger is being restored. Try again after it finishes.'},503);
        const access=agentKeys.authenticate(req.headers.authorization?.replace(/^Bearer /,'')??'');
        if(!access)return json({error:'Agent key required'},401);
        if(req.headers['mcp-protocol-version']&&!gscMcpVersions.includes(String(req.headers['mcp-protocol-version'])))return json({error:'Unsupported MCP protocol version'},400);
        if(req.method!=='POST'){res.setHeader('Allow','POST');return json({error:'SSE is not available'},405);}
        if(!req.headers['content-type']?.startsWith('application/json'))return json({error:'JSON required'},415);
        let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>65536)return json({error:'MCP request too large'},413);chunks.push(Buffer.from(chunk));}
        const response=agentMcp.respond(JSON.parse(Buffer.concat(chunks).toString('utf8')),access);if(!response){res.writeHead(202);return res.end();}return json(response);
      }
      if(path==='/gsc/mcp'){
        const received=Buffer.from(req.headers.authorization?.replace(/^Bearer /,'')??''),expected=Buffer.from(process.env.GSC_MCP_KEY??'');
        if(!expected.length||received.length!==expected.length||!timingSafeEqual(received,expected))return json({error:'MCP authentication required'},401);
        if(req.headers['mcp-protocol-version']&&!gscMcpVersions.includes(String(req.headers['mcp-protocol-version'])))return json({error:'Unsupported MCP protocol version'},400);
        if(req.method!=='POST'){res.setHeader('Allow','POST');return json({error:'SSE is not available'},405);}
        if(!req.headers['content-type']?.startsWith('application/json'))return json({error:'JSON required'},415);
        let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>65536)return json({error:'MCP request too large'},413);chunks.push(Buffer.from(chunk));}
        const response=gscMcp.respond(JSON.parse(Buffer.concat(chunks).toString('utf8')));if(!response){res.writeHead(202);return res.end();}return json(response);
      }
      if(path.startsWith('/gsc/share/')&&req.method==='GET'){
        try{const e=gscSharing.read(path.slice('/gsc/share/'.length),url.searchParams.get('key')??'');res.removeHeader('Content-Security-Policy');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(shareReport(e));}catch{return json({error:'分享链接无效或已撤销'},404);}
      }
      if (path.startsWith("/api/")) {
        const received = Buffer.from(
            req.headers.authorization?.replace(/^Bearer /, "") ?? "",
          ),
          expected = Buffer.from(token);
        if (
          received.length !== expected.length ||
          !timingSafeEqual(received, expected)
        )
          return json({ error: "请从应用启动链接打开 Console" }, 401);
        if (req.method === "GET") {
          if(path==='/api/account/status'){
            const access=connectionAccess();
            if(access?.status==='loading')return json({configured:false,status:'restoring',connectionsAccess:access});
            if(access?.status==='locked')return json({configured:false,status:'error',errorCode:'storage_unavailable',connectionsAccess:access});
            return json({...await account.ensureFresh(),...(access?{connectionsAccess:access}:{})});
          }
          if(['/api/google/resources','/api/google/selection','/api/ga4/report'].includes(path)){
            const access=connectionAccess();
            if(access&&access.status!=='ready')return json({error:'Saved connections are not ready.',code:'storage_unavailable'},409);
            const brandId=url.searchParams.get('brandId')??'';
            if(path==='/api/google/resources')return json(await googleData.resources(brandId||undefined));
            if(path==='/api/google/selection')return json(await googleData.selection(brandId));
            return json(await googleData.savedReport(brandId));
          }
          if(path==='/api/agent/keys')return json({url:origin+'/agent/mcp',keys:agentKeys.list()});
          if(path==='/api/agent/analyses')return json(agentMcp.read('getgeo_saved_analyses',{brandId:url.searchParams.get('brandId')??'',limit:1}));
          if(path==='/api/agent/context')return json(agentMcp.read('getgeo_audit_context',Object.fromEntries([...url.searchParams].filter(([name])=>['brandId','property','country','device','snapshotId','planId','auditId'].includes(name)))));
          if (path === '/api/keyword-audit/config') return json({
            providers: [
              {id:'openai',label:'OpenAI',available:!!process.env.OPENAI_API_KEY,model:process.env.SEO_AUDIT_OPENAI_MODEL || 'gpt-6.1-sol'},
              {id:'anthropic',label:'Claude',available:!!process.env.ANTHROPIC_API_KEY,model:process.env.SEO_AUDIT_ANTHROPIC_MODEL || 'claude-sonnet-5-5'},
            ],
            locations: keywordAuditLocations,
            dataForSeoConfigured:!!process.env.DATAFORSEO_LOGIN && !!process.env.DATAFORSEO_PASSWORD,
            demo:options.demo ?? false,
            limits:{serp:5,pages:20,llm:5},
          });
          if (path === '/api/keyword-audit/jobs') return json(keywordAudit.list(url.searchParams.get('brandId') ?? undefined));
          if (path === '/api/keyword-audit/job') return json(keywordAudit.get(url.searchParams.get('id') ?? ''));
          if (path === '/api/keyword-audit/markdown') return json({text:keywordAudit.markdown(url.searchParams.get('id') ?? '',reportLocale(url.searchParams.get('uiLocale')))});
          if(path==='/api/questions/local')return json(localQuestions.list(url.searchParams.get('brandId')??''));
          if(path==='/api/gsc/sync-status')return json(gscSync.status());
          if(path==='/api/gsc/shares')return json(gscSharing.list(url.searchParams.get('property')??'',origin));
          if(path==='/api/gsc/mcp-clients')return json([...gscMcp.clients.values()]);
          if (path === "/api/gsc/sites") return json(await gsc.available());
          if (path === '/api/gsc/items') return json(gscWorkspace.list(url.searchParams.get('property')??''));
          if (path === '/api/gsc/inspections') return json(gscWorkspace.inspections(url.searchParams.get('property')??''));
          if (path === "/api/gsc/markdown") return json({text:gscMarkdown(gsc.saved(url.searchParams.get("id") ?? ""),reportLocale(url.searchParams.get("uiLocale")))});
          if (path === "/api/gsc/history") return json(gsc.history());
          if (path === "/api/gsc/snapshot") return json(gsc.saved(url.searchParams.get("id") ?? ""));
          if (path === "/api/answers-markdown") {
            const planId=z.string().uuid().parse(url.searchParams.get("id"));
            return json(answerMarkdown(service.plan(planId),JSON.parse(service.brandForPlan(service.planRow(planId)).owned_domains),reportLocale(url.searchParams.get("uiLocale"))));
          }
          if (path === "/api/plan-sources") {
            const planId=z.string().uuid().parse(url.searchParams.get("id"));
            return json(identifySources(service.plan(planId), JSON.parse(service.brandForPlan(service.planRow(planId)).owned_domains)));
          }
          if (path === "/api/browser-screening") return json(browserJobs.screening(z.string().uuid().parse(url.searchParams.get("id"))));
          if (path === '/api/browser-login-readiness') return json(browserJobs.loginReadiness(z.string().uuid().parse(url.searchParams.get('id'))));
          if (path === '/api/browser-guest-readiness') return json(browserJobs.guestReadiness(z.string().uuid().parse(url.searchParams.get('id'))));
          if (path === "/api/state") {
            const state=service.state(url.searchParams.get("set") ?? undefined);
            return json({
              ...state,
              demo: options.demo ?? false,
              isolatedSampling: !!options.sampling,
              apiJobs: state.selectedSetId ? jobs.rows(state.selectedSetId) : [],
              browserJobs: state.selectedSetId ? browserJobs.rows(state.selectedSetId) : [],
              browserAvailability: browserJobs.availability(),
              browserSessions: options.browserCollector?.sessions?.()??[],
              settings: {
                persisted: !!options.persistSettings,
                access: connectionAccess(),
                fields: connectionFields.map((f) => ({
                  ...f,
                  configured: !!process.env[f.key],
                })),
              },
            });
          }
          if (path === "/api/ai-preview") {
            const preview = ai.preview(url.searchParams.get("id") ?? "");
            return json({ preview, hash: sha256(canonicalJson(preview)) });
          }
          if (path === "/api/ai-jobs")
            return json(ai.rows(url.searchParams.get("id") ?? ""));
          if (path === "/api/run")
            return json(service.observations(url.searchParams.get("id") ?? ""));
          if (path === "/api/report")
            return json(service.report(url.searchParams.get("id") ?? ""));
          if (path === "/api/export") {
            if(options.canMutate&&!options.canMutate())return json({error:'台账正在恢复，请稍后下载结果'},503);
            if(url.searchParams.get('format')==='md'){
              const result=exportReportMarkdown(service,url.searchParams.get('id')??'',reportLocale(url.searchParams.get('uiLocale')));
              res.setHeader('X-Report-SHA256',result.sha256);
              res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':'attachment; filename="geo-results.md"'});
              return res.end(result.markdown);
            }
            const r = createSnapshot(service, url.searchParams.get("id") ?? "", url.searchParams.get("format") === "json" ? "en" : reportLocale(url.searchParams.get("uiLocale")));
            if (url.searchParams.get("format") === "json") {
              res.writeHead(200, {
                "Content-Type": "application/json; charset=utf-8",
                "Content-Disposition":
                  'attachment; filename="geo-evidence-snapshot.json"',
              });
              return res.end(r.json);
            }
            res.setHeader("X-Report-SHA256", r.htmlHash);
            res.writeHead(200, {
              "Content-Type": "text/html; charset=utf-8",
              "Content-Disposition":
                'attachment; filename="geo-evidence-report.html"',
            });
            return res.end(r.html);
          }
          if (path === "/api/artifact") {
            const a = service.artifact(url.searchParams.get("id") ?? "");
            res.writeHead(200, {
              "Content-Type": a.mime,
              "Content-Disposition": "inline",
            });
            return res.end(a.bytes);
          }
        }
        if (req.method === "POST") {
          if (options.canMutate && !options.canMutate())
            return json({ error: "台账正在恢复，请等待恢复完成后重试" }, 503);
          if (!req.headers["content-type"]?.startsWith("application/json"))
            return json({ error: "需要 JSON 请求" }, 415);
          let size = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 6 * 1024 * 1024) {
              json({ error: "文件过大" }, 413);
              return;
            }
            chunks.push(Buffer.from(chunk));
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            requestId: string;
            input: unknown;
          };
          if (path === '/api/connections/unlock') {
            if (options.demo) throw new Error('演示模式不读取本机加密连接');
            if (!options.unlockConnections) throw new Error('此入口需要 Mac 应用的加密存储');
            await options.unlockConnections();
            return json({ ok: true, access: connectionAccess() });
          }
          if (['/api/settings', '/api/gsc/import', '/api/gsc/mcp-access', '/api/gsc/mcp-revoke'].includes(path)) {
            const access = connectionAccess();
            if (access && access.status !== 'ready') return json({
              error: access.status === 'loading' ? '连接配置正在加载，请稍后保存' : '连接配置尚未解锁，请先解锁后再保存',
            }, 409);
          }
          if(path==='/api/account/google-start'||path==='/api/account/gsc-start'||path==='/api/account/data-start'){
            const access=connectionAccess();
            if(access&&access.status!=='ready')return json({error:'Saved connections are not ready. Complete system authorization first.'},409);
            if(options.demo&&!options.accountProvider)throw new Error('Google sign-in is unavailable in the synthetic demo.');
            if(!options.persistSettings&&!options.accountProvider)throw new Error('Google sign-in needs encrypted desktop storage.');
            const openGoogle=async(result:{url:string;expiresAt:string})=>{
              const target=new URL(result.url);
              if(target.protocol!=='https:'||target.hostname!=='accounts.google.com'||target.pathname!=='/o/oauth2/v2/auth'||target.username||target.password||target.port)throw new Error('Invalid Google sign-in destination.');
              let opened=false;if(options.openExternal){try{await options.openExternal(result.url);opened=true;}catch{/* Keep the explicit browser fallback available. */}}
              return {url:result.url,expiresAt:result.expiresAt,opened};
            };
            if(path.endsWith('/data-start')){
              const requestId=z.string().uuid().parse(body.requestId);z.object({}).strict().parse(body.input);
              for(const [id,entry]of dataStarts)if(entry.expires<=Date.now())dataStarts.delete(id);
              const previous=dataStarts.get(requestId);if(previous)return json(await previous.operation);
              if(dataStarts.size>=64)throw new Error('Too many pending Google sign-in requests. Try again shortly.');
              if(!account.startData)throw new Error('Google data connection is not configured for this application.');
              unifiedAttempt=true;const revision=++dataStartRevision;
              const operation=(async()=>{const resume=await gscSync.pause();try{if(revision!==dataStartRevision)throw new Error('Google sign-in was cancelled.');const result=await account.startData!();if(revision!==dataStartRevision)throw new Error('Google sign-in was cancelled.');return await openGoogle(result);}finally{resume();}})();
              const entry={operation,expires:Date.now()+300_000};dataStarts.set(requestId,entry);
              try{const result=await operation;entry.expires=Number.isFinite(Date.parse(result.expiresAt))?Date.parse(result.expiresAt):entry.expires;return json(result);}
              catch(error){if(dataStarts.get(requestId)===entry)dataStarts.delete(requestId);throw error;}
            }
            const resume=await gscSync.pause();try{return json(await openGoogle(await (path.endsWith('/gsc-start')?account.startGsc():account.start())));}finally{resume();}
          }
          if(path==='/api/account/sign-out'){dataStartRevision++;dataStarts.clear();const resume=await gscSync.pause();try{await account.signOut();return json({ok:true});}finally{resume();}}
          if(['/api/google/selection','/api/ga4/report'].includes(path)){
            const access=connectionAccess();if(access&&access.status!=='ready')return json({error:'Saved connections are not ready.',code:'storage_unavailable'},409);
            if(path==='/api/google/selection')return json(await googleData.saveSelection(body.requestId,body.input));
            return json(await googleData.readReport(body.requestId,body.input));
          }
          if(path==='/api/agent/key-create')return json(agentKeys.create(body.requestId,body.input));
          if(path==='/api/agent/key-revoke')return json(agentKeys.revoke(body.input));
          if (path === '/api/keyword-audit/preview') return json(keywordAudit.preview(body.input));
          if (path === '/api/keyword-audit/start') {
            if(options.demo) throw new Error('演示模式不执行付费采集，请从本地应用连接真实数据');
            return json(keywordAudit.start(body.requestId,body.input));
          }
          if(path==='/api/questions/collect'){
            z.string().uuid().parse(body.requestId);
            const input=z.object({brandId:z.string().uuid()}).strict().parse(body.input);
            const collection=localQuestions.collect(input.brandId);return json({...localQuestions.list(input.brandId),collection});
          }
          if(path==='/api/questions/record')return json(localQuestions.importRecord(body.requestId,body.input));
          if(path==='/api/questions/create-set')return json(localQuestions.createSet(body.requestId,body.input));
          if(path==='/api/questions/markdown')return json(localQuestions.markdown(body.input));
          if(path==='/api/gsc/mcp-access'){
            if(!process.env.GSC_MCP_KEY){
              mcpKeyWrite ??= configure({GSC_MCP_KEY:randomBytes(32).toString('hex')},options.persistSettings).then(()=>{}).finally(()=>{mcpKeyWrite=undefined;});
              await mcpKeyWrite;
            }
            return json({url:origin+'/gsc/mcp',key:process.env.GSC_MCP_KEY});
          }
          if(path==='/api/gsc/mcp-revoke'){await configure({GSC_MCP_KEY:'DELETE'},options.persistSettings);gscMcp.clients.clear();return json({ok:true});}
          if(path==='/api/gsc/share-create')return json(gscSharing.create(body.requestId,body.input));
          if(path==='/api/gsc/share-revoke')return json(gscSharing.revoke(body.requestId,body.input));
          if (path === "/api/gsc/import") {if(managedGoogle())throw new Error('Reconnect Google to manage search access. Legacy imports are unavailable for a Google-connected account.');return json(await gsc.importExisting(options.persistSettings));}
          if (path === "/api/gsc/capture") {const result=await gsc.capture(body.requestId,body.input);collectLocal();return json(result);}
          if(path==='/api/gsc/sync'){
            const input=z.object({filters:z.unknown(),force:z.boolean().optional()}).strict().parse(body.input);
            return json(await gscSync.refresh(input.filters,input.force??false));
          }
          if (path === '/api/gsc/item-save') return json(gscWorkspace.save(body.requestId,body.input));
          if (path === '/api/gsc/item-remove') return json(gscWorkspace.remove(body.requestId,body.input));
          if (path === '/api/gsc/notes-import') return json(gscWorkspace.importNotes(body.requestId,body.input));
          if (path === '/api/gsc/sitemap') return json(await gsc.sitemap(body.input));
          if (path === '/api/gsc/inspect') return json(await gsc.inspect(body.requestId,body.input));
          if (
            path === "/api/open-sampling" ||
            path === "/api/capture-sampling"
          ) {
            if (!options.sampling) throw new Error("隔离窗口需要 Mac 应用");
            const input = z
              .object({ slotId: z.string().uuid() })
              .strict()
              .parse(body.input);
            const slot = service.slot(input.slotId),
              plan = service.plan(slot.plan_id);
            service.assertSetActive(plan.prompt_set_id);
            if(plan.config.accountMode&&plan.config.accountMode!=="signed_out")throw new Error("登录态计划请使用 Chrome 批量采样与独立登录准备");
            if (path === "/api/capture-sampling")
              return json(await options.sampling.capture(slot.id));
            if (service.restriction(service.scope(slot))?.action === "stop")
              throw new Error("此入口已因访问限制暂停");
            const today = new Intl.DateTimeFormat("en-CA", {
              timeZone: plan.config.timezone,
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
            }).format(new Date());
            if (slot.window !== today)
              throw new Error("只能打开计划时区中当天的采样任务");
            const prompt = plan.slots.find((s) => s.id === slot.id)!.prompt;
            const url =
              slot.surface === "google_aio" || slot.surface === "duckduckgo_search_assist"
                ? surfaces[slot.surface].url + "?q=" +
                  encodeURIComponent(prompt)
                : surfaces[slot.surface].url;
            return json(
              await options.sampling.open({
                slotId: slot.id,
                name: surfaces[slot.surface].name,
                url,
                locale: plan.config.locale,
              }),
            );
          }
          if (path === "/api/ai-jobs")
            return json(ai.create(body.requestId, body.input));
          if (path === "/api/browser-session") return json(await browserJobs.sessionControl(body.input));
          if (path === "/api/browser-guest-readiness") {
            if (options.demo) throw new Error("Demo mode does not open live guest entries.");
            return json(await browserJobs.checkGuestReadiness(body.input));
          }
          if (path === "/api/browser-jobs") return json(browserJobs.create(body.requestId, body.input));
          if (path === "/api/browser-control") return json(await browserJobs.control(body.input));
          if (path === "/api/ai-review")
            return json(ai.review(body.requestId, body.input));
          if (path === "/api/settings") {
            if (jobs.active.size || ai.active.size || browserJobs.active.size || keywordAudit.active.size)
              throw new Error("请先暂停正在运行的任务");
            return json(await configure(body.input, options.persistSettings));
          }
          if (path === "/api/api-jobs")
            return json(jobs.create(body.requestId, body.input));
          if (path === "/api/api-control")
            return json(jobs.control(body.requestId, body.input));
          if (["/api/brands/update","/api/brands/delete","/api/brands/restore"].includes(path)) {
            const action=path.endsWith("/update")?"edit":path.endsWith("/delete")?"delete":"restore";
            const result=service.changeBrand(body.requestId,action,body.input);
            if(action==="delete")for(const session of options.browserCollector?.sessions?.()??[]){
              const set=service.db.prepare("SELECT brand_id FROM prompt_set WHERE id=?").get(service.planRow(session.planId).prompt_set_id) as {brand_id:string};
              if(set.brand_id===result.id)await options.browserCollector?.closePlanSessions?.(session.planId);
            }
            return json(result);
          }
          if (path === "/api/brands")
            return json(service.createBrand(body.requestId, body.input));
          if (path === "/api/sets") {const result=service.createSet(body.requestId, body.input);collectLocal();return json(result);}
          if (path === "/api/freeze")
            return json(
              service.freeze(
                body.requestId,
                String((body.input as { setId?: string })?.setId ?? ""),
              ),
            );
          if (path === "/api/plans")
            return json(service.createPlan(body.requestId, body.input));
          if (path === "/api/captures")
            return json(service.capture(body.requestId, body.input));
          if (path === "/api/reviews")
            return json(service.review(body.requestId, body.input));
          if (path === "/api/release")
            return json(service.release(body.requestId, body.input));
        }
        return json({ error: "接口不存在" }, 404);
      }
      if (req.method !== "GET") return json({ error: "方法不允许" }, 405);
      const file = resolve(
        staticDir,
        path === "/" ? "index.html" : "." + decodeURIComponent(path),
      );
      if (!file.startsWith(resolve(staticDir) + sep) || !existsSync(file))
        return json({ error: "页面不存在" }, 404);
      const mime: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
      };
      if (!mime[extname(file)]) return json({ error: "文件类型不允许" }, 403);
      res.writeHead(200, { "Content-Type": mime[extname(file)] });
      res.end(readFileSync(file));
    } catch (error) {
      json({ error: error instanceof Error ? error.message : "操作失败",...(error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^[a-z_]{3,40}$/.test(error.code)?{code:error.code}:{}) }, 400);
    }
  });
  const listen=(port:number)=>new Promise<void>((ok,no)=>{
    const failed=(error:Error)=>{server.off('listening',ready);no(error);};
    const ready=()=>{server.off('error',failed);ok();};
    server.once('error',failed);server.once('listening',ready);server.listen(port,'127.0.0.1');
  });
  try{await listen(options.port??0);}catch(error){if(!options.fallbackPort||(error as NodeJS.ErrnoException).code!=='EADDRINUSE')throw error;await listen(0);}
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("无法启动本地服务");
  origin = `http://127.0.0.1:${addr.port}`;
  server.on('close',()=>{void gscSync.stop();void keywordAudit.stop();void account.dispose();});
  if(options.autoGsc)gscSync.start();
  return { server, jobs, ai, keywordAudit, browserJobs, gscSync, localQuestions, account, googleData, ga4, agentMcp, agentKeys, origin, url: `${origin}/#token=${token}`, token };
}
