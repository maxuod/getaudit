export type ImportedQuestion = { text: string; intent: "discovery" | "branded" };
export type ImportPreview = { prompts: ImportedQuestion[]; duplicates: number; blank: number; errors: string[]; format: string };

/** RFC-style quoted CSV/TSV reader. Imported cells are text and are never evaluated. */
function delimited(text: string, separator: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false, ended = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; ended = true; }
      else cell += c;
    } else if (c === separator) { row.push(cell); cell = ""; ended = false; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = ""; ended = false;
    } else if (c === '"' && cell === "" && !ended) quoted = true;
    else if (ended && c.trim()) throw new Error("CSV 引号闭合后出现额外字符");
    else cell += c;
  }
  if (quoted) throw new Error("CSV 有未闭合的双引号");
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
export function parseQuestions(input: string, format: "text" | "csv" | "tsv" = "text", defaultIntent: ImportedQuestion["intent"] = "discovery"): ImportPreview {
  const result: ImportPreview = { prompts: [], duplicates: 0, blank: 0, errors: [], format };
  if (input.length > 2_000_000) return { ...result, errors: ["文件超过 2 MB，请分批导入"] };
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  let rows: string[][];
  try { rows = format === "text" ? text.split("\n").map(t => [t]) : delimited(text, format === "csv" ? "," : "\t"); }
  catch (e) { return { ...result, errors: [(e as Error).message] }; }
  let questionColumn = 0, intentColumn = -1, offset = 0;
  if (format !== "text" && rows.length) {
    const headers = rows[0]!.map(v => v.trim().toLowerCase());
    const index = headers.findIndex(v => ["question", "prompt", "text", "问题", "问题原文"].includes(v));
    if (index >= 0) { questionColumn = index; intentColumn = headers.findIndex(v => ["intent", "type", "问题类型", "类型"].includes(v)); rows = rows.slice(1); offset = 1; }
    else if (rows.some(row => row.length > 1)) return { ...result, errors: ["多列文件必须包含 question、prompt 或 问题 列名；可下载模板"] };
  }
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const value = (row[questionColumn] ?? "").trim();
    if (!value) { result.blank++; return; }
    if (value.length > 3000) { result.errors.push(`第 ${i + offset + 1} 行问题超过 3000 字符`); return; }
    let intent = defaultIntent;
    const rawIntent = intentColumn < 0 ? "" : (row[intentColumn] ?? "").trim().toLowerCase();
    if (rawIntent) {
      if (["discovery", "发现型", "非品牌"].includes(rawIntent)) intent = "discovery";
      else if (["branded", "品牌型", "品牌"].includes(rawIntent)) intent = "branded";
      else { result.errors.push(`第 ${i + offset + 1} 行类型应为 discovery 或 branded`); return; }
    }
    if (seen.has(value)) { result.duplicates++; return; }
    seen.add(value); result.prompts.push({ text: value, intent });
  });
  if (result.prompts.length > 500) result.errors.push("去重后超过 500 题，请分成多个问题集");
  if (!result.prompts.length) result.errors.push("没有可导入的问题");
  return result;
}
