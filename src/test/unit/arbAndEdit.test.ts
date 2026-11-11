import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { arbLocale, arbPrefix, insertMessage, keyForMessage, missingKeys, parseArb, suggestKey } from '../../core/arb';
import { applyEdits, callExpression, extractionEdits } from '../../core/dartEdit';
import { findHardcodedStrings } from '../../core/hardcoded';
import { accessorFor, generateCommand, loadProject } from '../../core/project';

test('suggestKey builds a unique camelCase key', () => {
  assert.equal(suggestKey('Sign in to your account', {}), 'signAccount');
  assert.equal(suggestKey('Hello {name}!', { hello: 'x' }), 'hello2');
  assert.equal(suggestKey('Café ouvert', {}), 'cafeOuvert');
  assert.equal(suggestKey('2 items', {}), 'text2Items');
  assert.equal(suggestKey('!!!', {}), 'message');
});

test('insertMessage appends without touching the rest of the file', () => {
  const original = '{\n    "@@locale": "en",\n    "title":   "Shop"\n}\n';
  const out = insertMessage(original, 'greeting', 'Hello {name}', [{ name: 'name', expr: 'n' }], false);
  assert.ok(out.startsWith('{\n    "@@locale": "en",\n    "title":   "Shop",\n'));
  const arb = parseArb(out);
  assert.equal(arb.greeting, 'Hello {name}');
  assert.deepEqual(arb['@greeting'], { placeholders: { name: { type: 'Object' } } });
  assert.match(out, /\n    "greeting": "Hello \{name\}",\n    "@greeting": \{\n        "placeholders"/);
});

test('insertMessage handles an empty file, CRLF and refuses duplicates', () => {
  assert.equal(parseArb(insertMessage('{}', 'a', 'A', [], false)).a, 'A');
  const crlf = insertMessage('{\r\n  "a": "A"\r\n}\r\n', 'b', 'B', [], true);
  assert.ok(!/[^\r]\n/.test(crlf));
  assert.deepEqual(parseArb(crlf)['@b'], {});
  assert.throws(() => insertMessage('{"a": "A"}', 'a', 'A', [], false), /already exists/);
});

test('keyForMessage, missingKeys, locales', () => {
  const tpl = { '@@locale': 'en', a: 'A', '@a': {}, b: 'B' };
  assert.equal(keyForMessage(tpl, 'B'), 'b');
  assert.deepEqual(missingKeys(tpl, { a: 'X', b: '' }), ['b']);
  assert.equal(arbPrefix('app_en.arb', tpl), 'app_');
  assert.equal(arbPrefix('intl_en.arb'), 'intl_');
  assert.equal(arbLocale('app_zh_Hant.arb', 'app_'), 'zh_Hant');
  assert.equal(arbLocale('my_app_fr.arb', 'my_app_'), 'fr');
  assert.equal(arbLocale('other.arb', 'app_'), undefined);
});

test('extraction removes const, adds the import once, keeps the rest', () => {
  const src = "import 'package:flutter/material.dart';\n\nWidget a() => const Text('Hello $name');\n";
  const [c] = findHardcodedStrings(src);
  const accessor = { template: 'AppLocalizations.of(context)!.{key}', imports: ['package:shop/l10n/app_localizations.dart'] };
  const out = applyEdits(src, extractionEdits(src, c, callExpression(accessor, 'hello', c), accessor.imports));
  assert.equal(
    out,
    "import 'package:flutter/material.dart';\nimport 'package:shop/l10n/app_localizations.dart';\n\nWidget a() => Text(AppLocalizations.of(context)!.hello(name));\n",
  );
  const second = `${out}Widget b() => Text('Bye');\n`;
  const [c2] = findHardcodedStrings(second);
  const again = applyEdits(second, extractionEdits(second, c2, callExpression(accessor, 'bye', c2), accessor.imports));
  assert.equal(again.match(/app_localizations/g)?.length, 1);
  assert.match(again, /Text\(AppLocalizations\.of\(context\)!\.bye\)/);
});

function tempApp(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl10n-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

test('gen-l10n project: paths, class, nullable getter, import', () => {
  const root = tempApp({
    'pubspec.yaml': 'name: shop\nflutter:\n  generate: true\n',
    'l10n.yaml': 'arb-dir: lib/l10n\ntemplate-arb-file: app_en.arb\noutput-class: L10n\nnullable-getter: false\n',
  });
  const p = loadProject(root)!;
  assert.equal(p.mode, 'gen-l10n');
  assert.equal(p.templateArb, path.join(root, 'lib/l10n/app_en.arb'));
  const a = accessorFor(p);
  assert.equal(a.template, 'L10n.of(context).{key}');
  assert.deepEqual(a.imports, ['package:shop/l10n/app_localizations.dart']);
  assert.deepEqual(generateCommand(p, 'flutter'), { cmd: 'flutter', args: ['gen-l10n'] });
});

test('defaults keep the ! of the nullable getter', () => {
  const root = tempApp({ 'pubspec.yaml': 'name: a\n', 'l10n.yaml': '' });
  assert.equal(accessorFor(loadProject(root)!).template, 'AppLocalizations.of(context)!.{key}');
});

test('intl_utils project', () => {
  const root = tempApp({ 'pubspec.yaml': 'name: old\nflutter_intl:\n  enabled: true\n  main_locale: fr\n' });
  const p = loadProject(root)!;
  assert.equal(p.mode, 'intl_utils');
  assert.equal(path.basename(p.templateArb), 'intl_fr.arb');
  assert.deepEqual(accessorFor(p), { template: 'S.of(context).{key}', imports: ['package:old/generated/l10n.dart'] });
});

test('flutter_localisation project uses context.tr and its generator', () => {
  const root = tempApp({
    'pubspec.yaml': 'name: app\ndependencies:\n  flutter_localisation: ^2.7.0\n',
    'l10n.yaml': 'arb-dir: arbs/Default\noutput-dir: lib/localization/generated\n',
    'lib/generated_translation_methods.dart': '',
  });
  const p = loadProject(root)!;
  assert.equal(p.mode, 'flutter_localisation');
  assert.equal(accessorFor(p).template, 'context.tr.{key}');
  assert.deepEqual(generateCommand(p, 'flutter').args, ['run', 'flutter_localisation', 'arbs', 'Default']);
});

test('no l10n setup means no project, and a custom accessor wins', () => {
  assert.equal(loadProject(tempApp({ 'pubspec.yaml': 'name: x\n' })), undefined);
  const p = loadProject(tempApp({ 'pubspec.yaml': 'name: x\n', 'l10n.yaml': '' }))!;
  assert.deepEqual(accessorFor(p, 'context.l10n.{key}'), { template: 'context.l10n.{key}', imports: [] });
});
