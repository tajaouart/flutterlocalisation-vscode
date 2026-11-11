import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const root = (): string => vscode.workspace.workspaceFolders![0].uri.fsPath;

async function until<T>(get: () => T | undefined, what: string, ms = 10000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const ours = (uri: vscode.Uri): vscode.Diagnostic[] =>
  vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'Flutter Localization');

suite('Flutter Localization', () => {
  const main = (): vscode.Uri => vscode.Uri.file(path.join(root(), 'lib/main.dart'));

  test('reports the two hardcoded strings, not the ignored one', async () => {
    const doc = await vscode.workspace.openTextDocument(main());
    await vscode.window.showTextDocument(doc);
    const diags = await until(() => (ours(doc.uri).length ? ours(doc.uri) : undefined), 'diagnostics');
    assert.deepEqual(
      diags.map((d) => doc.getText(d.range)),
      ["'Welcome back'", "'Hello $name'"],
    );
  });

  test('offers the quick fix on a reported string', async () => {
    const doc = await vscode.workspace.openTextDocument(main());
    const d = ours(doc.uri)[0];
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      'vscode.executeCodeActionProvider',
      doc.uri,
      d.range,
    );
    assert.ok(actions.some((a) => a.title === 'Extract to ARB'));
  });

  test('extracting rewrites the Dart and the template ARB', async () => {
    const doc = await vscode.workspace.openTextDocument(main());
    const offset = doc.getText().indexOf("'Welcome back'");
    const key = await vscode.commands.executeCommand('flutterL10n.extract', doc.uri, offset + 1, 'welcomeBack');
    assert.equal(key, 'welcomeBack');
    const text = doc.getText();
    assert.match(text, /\n        Text\(AppLocalizations\.of\(context\)!\.welcomeBack\),/);
    assert.match(text, /^import 'package:shop\/l10n\/app_localizations\.dart';$/m);

    const helloAt = text.indexOf("'Hello $name'");
    await vscode.commands.executeCommand('flutterL10n.extract', doc.uri, helloAt + 1, 'helloName');
    assert.match(doc.getText(), /AppLocalizations\.of\(context\)!\.helloName\(name\)/);
    assert.equal(doc.getText().match(/app_localizations\.dart/g)?.length, 1);

    const arb = JSON.parse(fs.readFileSync(path.join(root(), 'lib/l10n/app_en.arb'), 'utf8'));
    assert.equal(arb.welcomeBack, 'Welcome back');
    assert.equal(arb.helloName, 'Hello {name}');
    assert.deepEqual(arb['@helloName'], { placeholders: { name: { type: 'Object' } } });
    assert.equal(arb.title, 'Shop');
  });

  test('extracting the same text again reuses the key', async () => {
    const doc = await vscode.workspace.openTextDocument(main());
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, doc.positionAt(doc.getText().lastIndexOf('      ],')), "        Text('Welcome back'),\n");
    await vscode.workspace.applyEdit(edit);
    const before = fs.readFileSync(path.join(root(), 'lib/l10n/app_en.arb'), 'utf8');
    await vscode.commands.executeCommand('flutterL10n.extract', doc.uri, doc.getText().lastIndexOf("'Welcome back'") + 1, 'welcomeBack');
    assert.equal(fs.readFileSync(path.join(root(), 'lib/l10n/app_en.arb'), 'utf8'), before);
    assert.equal(doc.getText().match(/\.welcomeBack/g)?.length, 2);
  });

  test('hover shows every locale and marks the missing one', async () => {
    const doc = await vscode.workspace.openTextDocument(main());
    const pos = doc.positionAt(doc.getText().indexOf('.welcomeBack') + 3);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, pos);
    const md = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))).join('\n');
    assert.match(md, /`en` \| Welcome back/);
    assert.match(md, /`fr` \| _missing_/);
  });

  test('a locale ARB missing keys gets a warning', async () => {
    const fr = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root(), 'lib/l10n/app_fr.arb')));
    await vscode.window.showTextDocument(fr);
    const [d] = await until(() => (ours(fr.uri).length ? ours(fr.uri) : undefined), 'ARB diagnostics');
    assert.equal(d.severity, vscode.DiagnosticSeverity.Warning);
    assert.match(d.message, /^3 keys missing in fr: cart, welcomeBack, helloName\./);
  });
});
