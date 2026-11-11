import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  Arb,
  KEY_PATTERN,
  arbLocale,
  arbPrefix,
  insertMessage,
  keyForMessage,
  missingKeys,
  parseArb,
  suggestKey,
} from './core/arb';
import { callExpression, extractionEdits } from './core/dartEdit';
import { Candidate, findHardcodedStrings, stringAt } from './core/hardcoded';
import { L10nProject, accessorFor, findRoot, generateCommand, loadProject } from './core/project';

const SOURCE = 'Flutter Localization';
const GUIDE_URL = 'https://flutterlocalisation.com/blog/migrate-intl-utils-flutter-intl-to-gen-l10n';
const SITE_URL = 'https://flutterlocalisation.com';

let output: vscode.OutputChannel;
const projects = new Map<string, L10nProject | null>();

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel(SOURCE);
  const dartDiagnostics = vscode.languages.createDiagnosticCollection('flutterL10n.strings');
  const arbDiagnostics = vscode.languages.createDiagnosticCollection('flutterL10n.arb');
  context.subscriptions.push(output, dartDiagnostics, arbDiagnostics);

  const timers = new Map<string, NodeJS.Timeout>();
  const scheduleDart = (doc: vscode.TextDocument): void => {
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => refreshDart(doc, dartDiagnostics), 300));
  };
  const refreshAllArbs = (): void => {
    for (const doc of vscode.workspace.textDocuments) refreshArb(doc, arbDiagnostics);
  };
  const refreshAll = (): void => {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.languageId === 'dart') refreshDart(doc, dartDiagnostics);
    }
    refreshAllArbs();
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((d) => (d.languageId === 'dart' ? scheduleDart(d) : refreshArb(d, arbDiagnostics))),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId === 'dart') scheduleDart(e.document);
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      dartDiagnostics.delete(d.uri);
      arbDiagnostics.delete(d.uri);
    }),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (!d.fileName.endsWith('.arb')) return;
      const project = projectFor(d.uri);
      if (project && isInside(d.fileName, project.arbDir)) {
        refreshAllArbs();
        if (setting<boolean>('generateOnSave')) void generate(project, false);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('flutterL10n')) refreshAll();
    }),
  );

  // A changed pubspec or l10n.yaml changes the whole setup.
  const watcher = vscode.workspace.createFileSystemWatcher('**/{pubspec.yaml,l10n.yaml}');
  const reset = (): void => {
    projects.clear();
    refreshAll();
  };
  watcher.onDidChange(reset);
  watcher.onDidCreate(reset);
  watcher.onDidDelete(reset);
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider({ language: 'dart', scheme: 'file' }, new ExtractActions(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorExtract],
    }),
    vscode.languages.registerHoverProvider({ language: 'dart', scheme: 'file' }, { provideHover }),
    vscode.commands.registerCommand('flutterL10n.extract', extract),
    vscode.commands.registerCommand('flutterL10n.generate', async () => {
      const project = await pickProject();
      if (project) await generate(project, true);
    }),
    vscode.commands.registerCommand('flutterL10n.openTemplate', async () => {
      const project = await pickProject();
      if (!project) return;
      if (!fs.existsSync(project.templateArb)) {
        vscode.window.showWarningMessage(`${path.relative(project.root, project.templateArb)} does not exist yet.`);
        return;
      }
      await vscode.window.showTextDocument(vscode.Uri.file(project.templateArb));
    }),
    vscode.commands.registerCommand('flutterL10n.doctor', () => runFl(['doctor'])),
    vscode.commands.registerCommand('flutterL10n.sync', () => runFl(['sync'])),
    vscode.commands.registerCommand('flutterL10n.migrateGuide', () => vscode.env.openExternal(vscode.Uri.parse(GUIDE_URL))),
  );

  refreshAll();
  void suggestMigration(context);
}

export function deactivate(): void {
  projects.clear();
}

function setting<T>(name: string): T | undefined {
  return vscode.workspace.getConfiguration('flutterL10n').get<T>(name);
}

function isInside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function projectFor(uri: vscode.Uri): L10nProject | undefined {
  if (uri.scheme !== 'file') return undefined;
  const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
  const root = findRoot(uri.fsPath, folder);
  if (!root) return undefined;
  if (!projects.has(root)) projects.set(root, loadProject(root) ?? null);
  return projects.get(root) ?? undefined;
}

async function pickProject(): Promise<L10nProject | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  const fromEditor = active && projectFor(active);
  if (fromEditor) return fromEditor;
  const found: L10nProject[] = [];
  for (const uri of await vscode.workspace.findFiles('**/{l10n.yaml,pubspec.yaml}', '**/{build,.dart_tool,ios,android,node_modules}/**', 50)) {
    const p = projectFor(uri);
    if (p && !found.some((f) => f.root === p.root)) found.push(p);
  }
  if (found.length <= 1) {
    if (!found.length) vscode.window.showWarningMessage('No Flutter app with an l10n.yaml (or a flutter_intl setup) in this workspace.');
    return found[0];
  }
  const pick = await vscode.window.showQuickPick(
    found.map((p) => ({ label: p.packageName, description: p.root, p })),
    { placeHolder: 'Which app?' },
  );
  return pick?.p;
}

// ---------------------------------------------------------------- diagnostics

function severity(): vscode.DiagnosticSeverity | undefined {
  switch (setting<string>('hardcodedStrings.severity')) {
    case 'off':
      return undefined;
    case 'hint':
      return vscode.DiagnosticSeverity.Hint;
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

function checksStrings(doc: vscode.TextDocument, project: L10nProject): boolean {
  const file = doc.fileName;
  return (
    isInside(file, path.join(project.root, 'lib')) &&
    !isInside(file, project.outputDir) &&
    !/\.(g|freezed|gr|mocks)\.dart$/.test(file) &&
    path.basename(file) !== 'generated_translation_methods.dart'
  );
}

function refreshDart(doc: vscode.TextDocument, collection: vscode.DiagnosticCollection): void {
  const sev = severity();
  const project = projectFor(doc.uri);
  if (sev === undefined || !project || doc.languageId !== 'dart' || !checksStrings(doc, project)) {
    collection.delete(doc.uri);
    return;
  }
  const text = doc.getText();
  collection.set(
    doc.uri,
    findHardcodedStrings(text).map((c) => {
      const d = new vscode.Diagnostic(
        new vscode.Range(doc.positionAt(c.start), doc.positionAt(c.end)),
        `Hardcoded text "${truncate(c.preview, 60)}". Extract it to ${path.basename(project.templateArb)} so it can be translated.`,
        sev,
      );
      d.source = SOURCE;
      d.code = 'hardcoded-string';
      return d;
    }),
  );
}

function refreshArb(doc: vscode.TextDocument, collection: vscode.DiagnosticCollection): void {
  if (!doc.fileName.endsWith('.arb')) return;
  const project = projectFor(doc.uri);
  if (!project || !isInside(doc.fileName, project.arbDir)) return;
  const diagnostics: vscode.Diagnostic[] = [];
  const top = new vscode.Range(0, 0, 0, Math.max(1, doc.lineAt(0).text.length));
  let arb: Arb | undefined;
  try {
    arb = parseArb(doc.getText());
  } catch (e) {
    diagnostics.push(diag(top, `Not valid ARB: ${(e as Error).message}`, vscode.DiagnosticSeverity.Error));
  }
  const isTemplate = path.resolve(doc.fileName) === path.resolve(project.templateArb);
  const template = readArb(project.templateArb);
  if (arb && !isTemplate && template && setting<boolean>('missingTranslations')) {
    const missing = missingKeys(template, arb);
    if (missing.length) {
      const locale = arbLocale(path.basename(doc.fileName), arbPrefix(path.basename(project.templateArb), template), arb) ?? 'this locale';
      const list = missing.slice(0, 8).join(', ') + (missing.length > 8 ? `, and ${missing.length - 8} more` : '');
      diagnostics.push(
        diag(top, `${missing.length} key${missing.length > 1 ? 's' : ''} missing in ${locale}: ${list}. They fall back to the template language.`, vscode.DiagnosticSeverity.Warning),
      );
    }
  }
  collection.set(doc.uri, diagnostics);
}

function diag(range: vscode.Range, message: string, sev: vscode.DiagnosticSeverity): vscode.Diagnostic {
  const d = new vscode.Diagnostic(range, message, sev);
  d.source = SOURCE;
  return d;
}

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------------------------------------------------------------- extraction

class ExtractActions implements vscode.CodeActionProvider {
  provideCodeActions(doc: vscode.TextDocument, range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const offset = doc.offsetAt(range.start);
    const ours = ctx.diagnostics.filter((d) => d.source === SOURCE && d.code === 'hardcoded-string');
    if (ours.length) {
      return ours.map((d) => {
        const a = new vscode.CodeAction('Extract to ARB', vscode.CodeActionKind.QuickFix);
        a.command = { command: 'flutterL10n.extract', title: 'Extract to ARB', arguments: [doc.uri, doc.offsetAt(d.range.start)] };
        a.diagnostics = [d];
        a.isPreferred = true;
        return a;
      });
    }
    if (!stringAt(doc.getText(), offset)) return [];
    const a = new vscode.CodeAction('Extract string to ARB', vscode.CodeActionKind.RefactorExtract);
    a.command = { command: 'flutterL10n.extract', title: 'Extract string to ARB', arguments: [doc.uri, offset] };
    return [a];
  }
}

/** Extracts the literal at [offset] (default: the cursor). [key] skips the prompt. */
async function extract(uri?: vscode.Uri, offset?: number, key?: string): Promise<string | undefined> {
  const doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
  if (!doc || doc.languageId !== 'dart') {
    vscode.window.showWarningMessage('Put the cursor in a string in a Dart file.');
    return undefined;
  }
  const at = offset ?? doc.offsetAt(vscode.window.activeTextEditor!.selection.active);
  const src = doc.getText();
  const candidate = stringAt(src, at);
  if (!candidate) {
    vscode.window.showWarningMessage('No string here that can become an ARB message (raw and multi-line strings, and text with { } are not supported).');
    return undefined;
  }
  let project = projectFor(doc.uri);
  if (!project) project = await offerSetup(doc.uri);
  if (!project) return undefined;

  const templateText = fs.existsSync(project.templateArb)
    ? fs.readFileSync(project.templateArb, 'utf8')
    : `{\n  "@@locale": "${arbLocale(path.basename(project.templateArb), arbPrefix(path.basename(project.templateArb))) ?? 'en'}"\n}\n`;
  let template: Arb;
  try {
    template = parseArb(templateText);
  } catch (e) {
    vscode.window.showErrorMessage(`${path.basename(project.templateArb)} is not valid JSON: ${(e as Error).message}`);
    return undefined;
  }
  const existing = keyForMessage(template, candidate.message);
  if (!key) {
    key = await vscode.window.showInputBox({
      title: `Extract "${truncate(candidate.preview, 50)}"`,
      prompt: existing
        ? `"${existing}" already holds this text. Keep it to reuse the key.`
        : `New key in ${path.basename(project.templateArb)}`,
      value: existing ?? suggestKey(candidate.message, template),
      validateInput: (v) => validateKey(v, template, candidate),
    });
    if (!key) return undefined;
  } else {
    const problem = validateKey(key, template, candidate);
    if (problem) throw new Error(problem);
  }

  const reuse = template[key] === candidate.message;
  const edit = new vscode.WorkspaceEdit();
  if (!reuse) {
    const updated = insertMessage(templateText, key, candidate.message, candidate.placeholders, !!setting<boolean>('addMetadata'));
    const arbUri = vscode.Uri.file(project.templateArb);
    if (fs.existsSync(project.templateArb)) {
      const arbDoc = await vscode.workspace.openTextDocument(arbUri);
      edit.replace(arbUri, new vscode.Range(arbDoc.positionAt(0), arbDoc.positionAt(arbDoc.getText().length)), updated);
    } else {
      edit.createFile(arbUri, { ignoreIfExists: true });
      edit.insert(arbUri, new vscode.Position(0, 0), updated);
    }
  }
  const accessor = accessorFor(project, setting<string>('accessor'));
  for (const e of extractionEdits(src, candidate, callExpression(accessor, key, candidate), accessor.imports)) {
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
  }
  if (!(await vscode.workspace.applyEdit(edit))) {
    vscode.window.showErrorMessage('Could not apply the edit.');
    return undefined;
  }
  if (!reuse) {
    const arbDoc = vscode.workspace.textDocuments.find((d) => path.resolve(d.fileName) === path.resolve(project!.templateArb));
    await arbDoc?.save();
    if (setting<boolean>('generateOnSave')) void generate(project, false);
  }
  return key;
}

function validateKey(v: string, template: Arb, candidate: Candidate): string | undefined {
  if (!KEY_PATTERN.test(v)) return 'Start with a lowercase letter; letters, digits and _ only.';
  if (v in template && template[v] !== candidate.message) {
    return `"${v}" already exists with a different text: "${truncate(String(template[v]), 60)}".`;
  }
  return undefined;
}

/** For a Flutter app with no l10n.yaml: offer to write a standard one. */
async function offerSetup(uri: vscode.Uri): Promise<L10nProject | undefined> {
  const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
  const root = findRoot(uri.fsPath, folder);
  if (!root) {
    vscode.window.showWarningMessage('This file is not inside a Flutter app (no pubspec.yaml above it).');
    return undefined;
  }
  const choice = await vscode.window.showInformationMessage(
    'This app has no l10n.yaml yet. Create one for gen-l10n (ARB files in lib/l10n, English template)?',
    'Create l10n.yaml',
    'Cancel',
  );
  if (choice !== 'Create l10n.yaml') return undefined;
  fs.writeFileSync(
    path.join(root, 'l10n.yaml'),
    'arb-dir: lib/l10n\ntemplate-arb-file: app_en.arb\noutput-localization-file: app_localizations.dart\nnullable-getter: false\n',
  );
  projects.delete(root);
  const pubspec = fs.readFileSync(path.join(root, 'pubspec.yaml'), 'utf8');
  if (!/^\s+flutter_localizations:/m.test(pubspec) || !/^\s+generate:\s*true/m.test(pubspec)) {
    vscode.window.showInformationMessage(
      'gen-l10n also needs flutter_localizations and intl as dependencies and `generate: true` under `flutter:` in pubspec.yaml.',
      'Run fl doctor',
    ).then((c) => c && runFl(['doctor']));
  }
  return projectFor(uri);
}

// ---------------------------------------------------------------- hover

const arbCache = new Map<string, { mtime: number; arb: Arb | undefined }>();

function readArb(file: string): Arb | undefined {
  try {
    const mtime = fs.statSync(file).mtimeMs;
    const open = vscode.workspace.textDocuments.find((d) => path.resolve(d.fileName) === path.resolve(file) && d.isDirty);
    if (open) return parseArb(open.getText());
    const hit = arbCache.get(file);
    if (hit && hit.mtime === mtime) return hit.arb;
    const arb = parseArb(fs.readFileSync(file, 'utf8'));
    arbCache.set(file, { mtime, arb });
    return arb;
  } catch {
    return undefined;
  }
}

function provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
  const range = doc.getWordRangeAtPosition(pos, /[A-Za-z_][A-Za-z0-9_]*/);
  if (!range || range.start.character === 0) return undefined;
  if (doc.getText(new vscode.Range(range.start.translate(0, -1), range.start)) !== '.') return undefined;
  const project = projectFor(doc.uri);
  if (!project) return undefined;
  const key = doc.getText(range);
  const template = readArb(project.templateArb);
  if (!template || typeof template[key] !== 'string') return undefined;

  const prefix = arbPrefix(path.basename(project.templateArb), template);
  const rows: string[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(project.arbDir).filter((f) => f.endsWith('.arb')).sort();
  } catch {
    return undefined;
  }
  for (const f of files) {
    const arb = readArb(path.join(project.arbDir, f));
    if (!arb) continue;
    const locale = arbLocale(f, prefix, arb) ?? f;
    const value = arb[key];
    rows.push(`| \`${locale}\` | ${typeof value === 'string' && value ? escapeCell(value) : '_missing_'} |`);
  }
  const md = new vscode.MarkdownString(`**${key}**\n\n| Locale | Text |\n|---|---|\n${rows.join('\n')}`);
  const meta = template[`@${key}`] as { description?: string } | undefined;
  if (meta?.description) md.appendMarkdown(`\n\n${meta.description}`);
  return new vscode.Hover(md, range);
}

const escapeCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

// ---------------------------------------------------------------- generation

function flutterExecutable(): string {
  const own = setting<string>('flutterPath');
  if (own) return own;
  const sdk = vscode.workspace.getConfiguration('dart').get<string>('flutterSdkPath');
  if (sdk) {
    const bin = path.join(sdk, 'bin', process.platform === 'win32' ? 'flutter.bat' : 'flutter');
    if (fs.existsSync(bin)) return bin;
  }
  return 'flutter';
}

const running = new Map<string, Promise<boolean>>();

async function generate(project: L10nProject, showOutput: boolean): Promise<boolean> {
  const pending = running.get(project.root);
  if (pending) return pending;
  const { cmd, args } = generateCommand(project, flutterExecutable());
  const job = new Promise<boolean>((resolve) => {
    output.appendLine(`$ ${cmd} ${args.join(' ')}   (${project.root})`);
    if (showOutput) output.show(true);
    const child = spawn(cmd, args, { cwd: project.root, shell: process.platform === 'win32' });
    child.stdout.on('data', (b) => output.append(String(b)));
    child.stderr.on('data', (b) => output.append(String(b)));
    child.on('error', (e) => {
      output.appendLine(String(e));
      vscode.window
        .showErrorMessage(`Could not run ${cmd}. Set flutterL10n.flutterPath to your flutter executable.`, 'Open Settings')
        .then((c) => c && vscode.commands.executeCommand('workbench.action.openSettings', 'flutterL10n.flutterPath'));
      resolve(false);
    });
    child.on('close', (code) => {
      if (code === 0) {
        vscode.window.setStatusBarMessage('$(check) Localizations regenerated', 3000);
        resolve(true);
      } else {
        vscode.window.showErrorMessage(`Regenerating localizations failed (exit ${code}).`, 'Show Output').then((c) => c && output.show());
        resolve(false);
      }
    });
  }).finally(() => running.delete(project.root));
  running.set(project.root, job);
  return job;
}

// ---------------------------------------------------------------- fl CLI

function findFl(): string | undefined {
  const exe = process.platform === 'win32' ? 'fl.bat' : 'fl';
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  dirs.push(path.join(os.homedir(), '.pub-cache', 'bin'));
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Pub', 'Cache', 'bin'));
  for (const d of dirs) {
    const p = path.join(d, exe);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

async function runFl(args: string[]): Promise<void> {
  const project = await pickProject();
  const fl = findFl();
  if (!fl) {
    const c = await vscode.window.showInformationMessage(
      'This needs the fl command line tool from FlutterLocalisation (free, open source).',
      'Install it',
      'Learn more',
    );
    if (c === 'Install it') {
      const t = vscode.window.createTerminal({ name: SOURCE });
      t.show();
      t.sendText('dart pub global activate flutter_localisation_cli');
    } else if (c === 'Learn more') {
      void vscode.env.openExternal(vscode.Uri.parse(`${SITE_URL}/blog/flutter-localisation-agent-skill`));
    }
    return;
  }
  const t = vscode.window.createTerminal({ name: SOURCE, cwd: project?.root });
  t.show();
  t.sendText([fl, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '));
}

// ---------------------------------------------------------------- intl_utils

async function suggestMigration(context: vscode.ExtensionContext): Promise<void> {
  if (context.workspaceState.get('flutterL10n.migrationShown')) return;
  for (const uri of await vscode.workspace.findFiles('**/pubspec.yaml', '**/{build,.dart_tool,node_modules}/**', 20)) {
    const p = projectFor(uri);
    if (p?.mode !== 'intl_utils') continue;
    await context.workspaceState.update('flutterL10n.migrationShown', true);
    const c = await vscode.window.showInformationMessage(
      `${p.packageName} uses intl_utils (Flutter Intl), which is discontinued on pub.dev. Extraction still works here; moving to gen-l10n takes a few minutes.`,
      'Migration guide',
    );
    if (c) void vscode.env.openExternal(vscode.Uri.parse(GUIDE_URL));
    return;
  }
}
