import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
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
  const helper = (): string => path.join(root(), 'lib/l10n/locale_preview.dart');

  test('Preview in all locales writes the annotation and a preview function', async () => {
    const file = path.join(root(), 'lib/price_tag.dart');
    fs.writeFileSync(
      file,
      [
        "import 'package:flutter/material.dart';",
        '',
        "import 'l10n/app_localizations.dart';",
        '',
        'class PriceTag extends StatelessWidget {',
        '  const PriceTag({super.key});',
        '',
        '  @override',
        '  Widget build(BuildContext context) => Text(AppLocalizations.of(context)!.title);',
        '}',
        '',
      ].join('\n'),
    );
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc);
    const name = await vscode.commands.executeCommand<string>('flutterL10n.previewLocales', doc.uri, doc.getText().indexOf('build'));
    assert.equal(name, 'priceTagLocalePreview');
    assert.match(doc.getText(), /import 'package:shop\/l10n\/locale_preview\.dart';\n/);
    assert.match(doc.getText(), /\}\n\n@LocalePreview\(\)\nWidget priceTagLocalePreview\(\) => const PriceTag\(\);/);
    await doc.save();
    assert.match(read(helper()), /String get welcomeBack => _p\(super\.welcomeBack\);/);

    // A widget with required arguments: the call is selected for the user to complete.
    const main = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root(), 'lib/main.dart')));
    const editor = await vscode.window.showTextDocument(main);
    await vscode.commands.executeCommand('flutterL10n.previewLocales', main.uri, main.getText().indexOf('class Home'));
    assert.equal(main.getText(editor.selection), 'Home()');
    await vscode.commands.executeCommand('type', { text: "Home(name: 'Sam')" });
    await main.save();
    assert.match(main.getText(), /Widget homeLocalePreview\(\) => Home\(name: 'Sam'\);/);
    assert.equal((main.getText().match(/locale_preview\.dart/g) ?? []).length, 1);

    // Running it again only moves to the existing function.
    await vscode.commands.executeCommand('flutterL10n.previewLocales', main.uri, main.getText().indexOf('class Home'));
    assert.equal((main.getText().match(/homeLocalePreview/g) ?? []).length, 1);
  });

  test('the helper follows the ARB files when they are regenerated', async () => {
    const arbPath = path.join(root(), 'lib/l10n/app_en.arb');
    const arb = await vscode.workspace.openTextDocument(vscode.Uri.file(arbPath));
    await vscode.window.showTextDocument(arb);
    const text = arb.getText();
    const edit = new vscode.WorkspaceEdit();
    const close = text.lastIndexOf('}');
    edit.insert(arb.uri, arb.positionAt(text.lastIndexOf('"', close) + 1), ',\n  "greet": "Hi {who}",\n  "@greet": {"placeholders": {"who": {"type": "String"}}}');
    await vscode.workspace.applyEdit(edit);
    await arb.save();
    await until(() => /String greet\(String who\) => _p\(super\.greet\(who\)\);/.test(read(helper())), 'the helper to pick up greet');
  });

  test('the previews compile and render every locale, right to left and the pseudo-locale', () => {
    fs.mkdirSync(path.join(root(), 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(root(), 'test/locale_preview_test.dart'),
      `import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shop/price_tag.dart';
import 'package:shop/l10n/locale_preview.dart';
import 'package:shop/main.dart';

void main() {
  final previews = const LocalePreview().transform();

  test('one preview per locale, right to left and pseudo', () {
    expect(previews.map((p) => p.name).toSet(), {'en', 'fr', 'en, right to left', 'Pseudo-locale (+40%)'});
  });

  const expected = {
    'en': ('Shop', TextDirection.ltr),
    'fr': ('Boutique', TextDirection.ltr),
    'en, right to left': ('Shop', TextDirection.rtl),
    'Pseudo-locale (+40%)': ('[Shöp~~]', TextDirection.ltr),
  };
  for (final p in previews) {
    testWidgets(p.name!, (tester) async {
      final l = p.localizations!();
      for (final widget in [priceTagLocalePreview(), homeLocalePreview()]) {
        await tester.pumpWidget(MaterialApp(
          locale: l.locale,
          supportedLocales: l.supportedLocales,
          localizationsDelegates: l.localizationsDelegates,
          home: Scaffold(body: p.wrapper?.call(widget) ?? widget),
        ));
        final (title, direction) = expected[p.name]!;
        expect(find.text(title), findsOneWidget);
        expect(Directionality.of(tester.element(find.text(title))), direction);
      }
    });
  }
}
`,
    );
    const shell = process.platform === 'win32';
    execFileSync('flutter', ['analyze', '--no-fatal-infos'], { cwd: root(), stdio: 'inherit', shell });
    execFileSync('flutter', ['test', 'test/locale_preview_test.dart'], { cwd: root(), stdio: 'inherit', shell });
  });
});
