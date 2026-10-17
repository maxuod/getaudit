import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const consoleDirectory = path.resolve('apps/console');
function catalog(file, variable) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(consoleDirectory, 'locales', file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let result;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variable) {
      let value = node.initializer;
      while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) value = value.expression;
      if (!ts.isObjectLiteralExpression(value)) throw new Error(`${file}: expected a static catalog`);
      result = Object.fromEntries(value.properties.map(property => {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name) || !ts.isStringLiteral(property.initializer)) throw new Error(`${file}: catalog entries must be static string messages`);
        return [property.name.text, property.initializer.text];
      }));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!result) throw new Error(`${file}: ${variable} was not found`);
  return result;
}
const english = catalog('en.ts', 'en'), chinese = catalog('zh-CN.ts', 'zhCN');
const placeholders = text => [...new Set([...text.matchAll(/\{(\w+)(?::[^{}]*\|[^{}]*)?\}/g)].map(match => match[1]))].sort();
const problems = [];
for (const [key, message] of Object.entries(english)) {
  if (!/^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+$/.test(key)) problems.push(`${key}: use a semantic English message ID`);
  if (/[\u3400-\u9fff]/.test(message)) problems.push(`${key}: English source contains Chinese text`);
  if (!Object.hasOwn(chinese, key)) problems.push(`${key}: Chinese translation is missing`);
  else if (JSON.stringify(placeholders(message)) !== JSON.stringify(placeholders(chinese[key]))) problems.push(`${key}: English and Chinese placeholders differ`);
}
for (const key of Object.keys(chinese)) if (!Object.hasOwn(english, key)) problems.push(`${key}: translation has no English source`);
let calls = 0;
const coverage = {};
for (const file of fs.readdirSync(consoleDirectory).filter(name => /\.tsx?$/.test(name))) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(consoleDirectory, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let count = 0;
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
      count++;
      const first = node.arguments[0], second = node.arguments[1];
      const location = `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
      if (ts.isStringLiteral(first) && !Object.hasOwn(english, first.text)) problems.push(`${location}: unknown English message ID ${first.text}`);
      if (second && (ts.isStringLiteral(second) || ts.isTemplateExpression(second) || ts.isNoSubstitutionTemplateLiteral(second))) problems.push(`${location}: inline bilingual copy must move to catalogs`);
      if (ts.isTemplateExpression(first) || ts.isNoSubstitutionTemplateLiteral(first)) problems.push(`${location}: message ID must be stable, not generated from copy`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  coverage[file] = count;
  calls += count;
}
if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
else console.log(JSON.stringify({ sourceLanguage:'en', fallbackLanguage:'en', messages:Object.keys(english).length, chineseTranslations:Object.keys(chinese).length, keyedCalls:calls, coverage, placeholderParity:true }, null, 2));
