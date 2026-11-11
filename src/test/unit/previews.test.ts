import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { generatedMembers, localeClass, localeFile, previewFunctionName, previewHelper, widgetClassAt, widgetClasses } from '../../core/previews';
import { L10nProject } from '../../core/project';

const generated = fs.readFileSync(path.resolve(__dirname, '../../../fixtures/generated/app_localizations_en.dart'), 'utf8');

const project = (over: Partial<L10nProject> = {}): L10nProject => ({
  root: '/app',
  packageName: 'shop',
  mode: 'gen-l10n',
  arbDir: '/app/lib/l10n',
  templateArb: '/app/lib/l10n/app_en.arb',
  outputDir: '/app/lib/l10n',
  outputFile: '/app/lib/l10n/app_localizations.dart',
  className: 'AppLocalizations',
  nullableGetter: true,
  ...over,
});

test('localeClass and localeFile follow gen-l10n naming', () => {
  assert.equal(localeClass('AppLocalizations', 'en'), 'AppLocalizationsEn');
  assert.equal(localeClass('L10n', 'zh_Hant_TW'), 'L10nZhHantTw');
  assert.equal(localeFile(project(), 'en_US'), '/app/lib/l10n/app_localizations_en.dart');
});

test('generatedMembers reads getters and methods, including plural and currency bodies', () => {
  assert.deepEqual(generatedMembers(generated, 'AppLocalizationsEn'), [
    { name: 'title' },
    { name: 'helloName', params: 'String name' },
    { name: 'items', params: 'int count' },
    { name: 'total', params: 'double amount' },
    { name: 'payNow' },
  ]);
  assert.equal(generatedMembers(generated, 'AppLocalizationsFr'), undefined);
});

test('previewHelper overrides every message in the pseudo-locale', () => {
  const out = previewHelper({ project: project(), templateLocale: 'en', templateSource: generated });
  assert.match(out, /final class LocalePreview extends MultiPreview/);
  assert.match(out, /import 'app_localizations_en\.dart';/);
  assert.match(out, /class _Pseudo extends AppLocalizationsEn \{/);
  assert.match(out, /String helloName\(String name\) => _p\(super\.helloName\(name\)\);/);
  assert.match(out, /String get payNow => _p\(super\.payNow\);/);
  assert.match(out, /Locale\.fromSubtags\(languageCode: 'en'\)/);
  assert.doesNotMatch(out, /TranslationProvider/);
  assert.doesNotMatch(out, /[\u2013\u2014]/);
});

test('previewHelper without generated code skips the pseudo-locale', () => {
  const out = previewHelper({ project: project(), templateLocale: 'en_US' });
  assert.doesNotMatch(out, /_Pseudo|foundation\.dart|pseudo/);
  assert.match(out, /countryCode: 'US'/);
  assert.match(out, /supported locale is already\./);
});

test('previewHelper wraps previews in a TranslationProvider for the package', () => {
  const out = previewHelper({ project: project({ mode: 'flutter_localisation' }), templateLocale: 'en', templateSource: generated });
  assert.match(out, /import 'package:flutter_localisation\/flutter_localisation\.dart';/);
  assert.equal(out.match(/wrapper: _provide,/g)?.length, 2);
  assert.match(out, /child: _provide\(child\)\)/);
  assert.match(out, /generatedLocalizations: AppLocalizations\.of\(context\)/);
});

test('widgetClasses finds concrete widgets and their extent', () => {
  const src = [
    "import 'package:flutter/material.dart';",
    'abstract class Base extends StatelessWidget {}',
    'class Card extends StatelessWidget {',
    "  final s = '}';",
    '  Widget build(BuildContext c) => Text("{");',
    '}',
    'class _Row<T> extends StatefulWidget { }',
    'class Model extends ChangeNotifier {}',
  ].join('\n');
  assert.deepEqual(widgetClasses(src).map((c) => c.name), ['Card', '_Row']);
  const card = widgetClasses(src)[0];
  assert.equal(src.slice(card.end - 1, card.end), '}');
  assert.equal(src.slice(card.start, card.end).split('\n').length, 4);
  assert.equal(widgetClassAt(src, src.indexOf('build'))?.name, 'Card');
  assert.equal(widgetClassAt(src, src.indexOf('Model')), undefined);
});

test('previewFunctionName is public', () => {
  assert.equal(previewFunctionName('CheckoutCard'), 'checkoutCardLocalePreview');
  assert.equal(previewFunctionName('_Row'), 'rowLocalePreview');
});
