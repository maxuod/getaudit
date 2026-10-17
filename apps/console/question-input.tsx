import {t, useUiLanguage, uiMessage} from "./i18n.tsx";
import {downloadText} from "./download.ts";
import React, {useMemo, useState} from "react";
import {parseQuestions, type ImportedQuestion} from "../../src/console/question-import.ts";
export function QuestionInput() {
  useUiLanguage();
  const [raw,setRaw]=useState(""),[format,setFormat]=useState<"text"|"csv"|"tsv">("text"),[intent,setIntent]=useState<ImportedQuestion["intent"]>("discovery"),[fileError,setFileError]=useState(""),[fileName,setFileName]=useState("");
  const preview=useMemo(()=>parseQuestions(raw,format,intent),[raw,format,intent]);
  return <section className="question-import">
    <div className="form-grid"><label className="field"><span>{t("questionInput.importQuestionsFile")}</span><input type="file" accept=".txt,.csv,.tsv,text/plain,text/csv" onChange={async e=>{
      const f=e.target.files?.[0];if(!f)return;setFileError("");
      if(f.size>2_000_000){setFileError(t("questionInput.fileExceeds2MBImportItInBatches"));return;}
      const ext=f.name.split(".").at(-1)?.toLowerCase();if(!["txt","csv","tsv"].includes(ext??"")){setFileError(t("questionInput.tXTCSVAndTSVAreSupportedSaveExcelFilesAsCSV"));return;}
      try{const text=await f.text();setRaw(text);setFormat(ext==="csv"?"csv":ext==="tsv"?"tsv":"text");setFileName(f.name);}catch{setFileError(t("questionInput.couldNotReadTheFile"));}
    }}/></label><label className="field"><span>{t("questionInput.textFormat")}</span><select value={format} onChange={e=>setFormat(e.target.value as typeof format)}><option value="text">{t("questionInput.tXTOneQuestionPerLine")}</option><option value="csv">CSV: question, intent</option><option value="tsv">{t("questionInput.pasteFromExcelTSV")}</option></select></label></div>
    <p className="muted">{t("questionInput.filesAreParsedLocallyUpTo500QuestionsQuotedCSVAnd")}</p>
    <button type="button" onClick={()=>downloadText("geo-questions-template.csv",'\uFEFFquestion,intent\r\n"How can a small restaurant plan weekly shifts?",discovery\r\n',"text/csv;charset=utf-8")}>{t("questionInput.downloadCSVTemplate")}</button>
    <label className="field"><span>{t("questionInput.originalQuestions")}{fileName&&`· ${fileName}`}</span><textarea rows={7} value={raw} required onChange={e=>{setRaw(e.target.value);setFileError("");}} placeholder={t("questionInput.oneQuestionPerLineOrImportAFileAndCheckThe")}/></label>
    <label className="field"><span>{t("questionInput.defaultQuestionTypeTheFileSIntentColumnTakesPriority")}</span><select value={intent} onChange={e=>setIntent(e.target.value as typeof intent)}><option value="discovery">{t("questionInput.discoveryNonBranded")}</option><option value="branded">{t("questionInput.branded")}</option></select></label>
    <input type="hidden" name="importedQuestions" value={JSON.stringify({prompts:preview.prompts,errors:fileError?[fileError]:preview.errors})}/>
    {raw&&<><p role="status">{t("questionInput.previewPromptCountQuestionsDuplicatesDuplicatesRemovedBlankBlankLinesIgnored", { promptCount: preview.prompts.length, duplicates: preview.duplicates, blank: preview.blank })}</p><ol className="question-preview">{preview.prompts.slice(0,5).map((p,i)=><li key={i}>{p.text}<small className="muted"> · {p.intent==="branded"?t("questionInput.branded"):t("questionInput.discovery")}</small></li>)}</ol>{preview.prompts.length>5&&<small>{t("questionInput.showingTheFirst5QuestionsAllPromptCountAreImportedWhenSaved", { promptCount: preview.prompts.length })}</small>}</>}
    {(fileError||preview.errors.length>0&&raw)&&<p className="alert error" role="alert">{fileError ? uiMessage(fileError) : preview.errors.map(uiMessage).join(t("questionInput.message"))}</p>}
  </section>;
}
