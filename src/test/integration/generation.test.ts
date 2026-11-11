import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const root = (): string => vscode.workspace.workspaceFolders![0].uri.fsPath;
const generated = (): string => path.join(root(), 'lib/l10n/app_localizations.dart');

async function until(check: () => boolean, what: string, ms = 90000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const read = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

suite('Generation with a real Flutter SDK', () => {
  test('extracting through the key prompt regenerates gen-l10n', async () => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root(), 'lib/main.dart')));
    const editor = await vscode.window.showTextDocument(doc);
    const at = doc.positionAt(doc.getText().indexOf("'Welcome back'") + 2);
    editor.selection = new vscode.Selection(at, at);

    // Same path as the keyboard shortcut: no arguments, so the prompt opens
    // with the suggested key, and Enter accepts it.
    const pending = vscode.commands.executeCommand<string | undefined>('flutterL10n.extract');
    await new Promise((r) => setTimeout(r, 1500));
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    assert.equal(await pending, 'welcomeBack');

    await until(() => /String get welcomeBack;/.test(read(generated())), 'flutter gen-l10n to write welcomeBack');
    assert.match(doc.getText(), /AppLocalizations\.of\(context\)!\.welcomeBack/);
  });

  test('saving an edited ARB file regenerates again', async () => {
    const arbPath = path.join(root(), 'lib/l10n/app_en.arb');
    const arb = await vscode.workspace.openTextDocument(vscode.Uri.file(arbPath));
    await vscode.window.showTextDocument(arb);
    const text = arb.getText();
    const edit = new vscode.WorkspaceEdit();
    const close = text.lastIndexOf('}');
    edit.insert(arb.uri, arb.positionAt(text.lastIndexOf('"', close) + 1), ',\n  "checkout": "Checkout"');
    await vscode.workspace.applyEdit(edit);
    await arb.save();
    await until(() => /String get checkout;/.test(read(generated())), 'regeneration after saving the ARB');
  });
});
