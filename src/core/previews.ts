import * as path from 'path';
import { tokenize } from './dartLexer';
import { L10nProject } from './project';

export const HELPER_FILE = 'locale_preview.dart';

/** gen-l10n's class for [locale]: `AppLocalizations` + `en_US` gives `AppLocalizationsEnUs`. */
export function localeClass(className: string, locale: string): string {
  return className + locale.split(/[_-]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('');
}

/** The file gen-l10n writes the [locale] class into: one per language. */
export function localeFile(project: L10nProject, locale: string): string {
  const base = project.outputFile.replace(/\.dart$/, '');
  return `${base}_${locale.split(/[_-]/)[0].toLowerCase()}.dart`;
}

export interface Member {
  name: string;
  /** Parameter list as declared, without the brackets; undefined for a getter. */
  params?: string;
}

/** The messages a generated gen-l10n locale class overrides, read from its source. */
export function generatedMembers(source: string, cls: string): Member[] | undefined {
  const start = source.search(new RegExp(`\\bclass\\s+${cls}\\s+extends\\b`));
  if (start < 0) return undefined;
  const open = source.indexOf('{', start);
  const end = closingBrace(source, open);
  if (end < 0) return undefined;
  const body = source.slice(open, end);
  const members: Member[] = [];
  const re = /@override\s+String\s+(?:get\s+(\w+)\s*=>|(\w+)\s*\(([^)]*)\)\s*\{)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    members.push(m[1] ? { name: m[1] } : { name: m[2], params: m[3].trim().replace(/,$/, '') });
  }
  return members;
}

const paramNames = (params: string): string[] =>
  params
    .split(',')
    .map((p) => p.trim().split(/\s+/).pop()!)
    .filter(Boolean);

function closingBrace(src: string, open: number): number {
  let depth = 0;
  for (const t of tokenize(src.slice(open))) {
    if (t.kind !== 'punct') continue;
    if (t.text === '{') depth++;
    else if (t.text === '}' && --depth === 0) return open + t.start;
  }
  return -1;
}

function dartLocale(locale: string): string {
  const [lang, ...rest] = locale.split(/[_-]/);
  const script = rest.find((p) => p.length === 4);
  const country = rest.find((p) => p.length !== 4);
  const args = [`languageCode: '${lang}'`];
  if (script) args.push(`scriptCode: '${script}'`);
  if (country) args.push(`countryCode: '${country}'`);
  return `Locale.fromSubtags(${args.join(', ')})`;
}

export interface HelperInput {
  project: L10nProject;
  /** Locale of the template ARB, such as `en`. */
  templateLocale: string;
  /** Source of the generated file holding the template locale's class, if it exists yet. */
  templateSource?: string;
}

/** Source of the helper that declares the `@LocalePreview()` annotation. */
export function previewHelper({ project, templateLocale, templateSource }: HelperInput): string {
  const cls = project.className;
  const templateCls = localeClass(cls, templateLocale);
  const members = templateSource ? generatedMembers(templateSource, templateCls) : undefined;
  const pseudo = !!members;
  const provider = project.mode === 'flutter_localisation';
  const outFile = path.basename(project.outputFile);
  const templateFile = path.basename(localeFile(project, templateLocale));

  const imports = [
    ...(pseudo ? ["import 'package:flutter/foundation.dart';"] : []),
    "import 'package:flutter/widgets.dart';",
    "import 'package:flutter/widget_previews.dart';",
    ...(provider ? ["import 'package:flutter_localisation/flutter_localisation.dart';"] : []),
    '',
    `import '${outFile}';`,
    ...(pseudo ? [`import '${templateFile}';`] : []),
  ];

  const out: string[] = [
    '// Written by the Flutter Localization extension and rewritten when the',
    '// localizations are regenerated. Changes here are lost.',
    '// ignore_for_file: type=lint',
    '',
    ...imports,
    '',
    '/// Previews a widget in every supported locale, and right to left when no',
    `/// supported locale is${pseudo ? '' : ' already.'}`,
    ...(pseudo
      ? ['/// already. A pseudo-locale with longer, accented text shows clipping', '/// before any translation exists.']
      : []),
    '///',
    '/// ```dart',
    '/// @LocalePreview()',
    '/// Widget checkoutPreview() => const CheckoutPage();',
    '/// ```',
    'final class LocalePreview extends MultiPreview {',
    `  const LocalePreview({this.group = 'Locales', this.size${pseudo ? ', this.pseudo = true' : ''}});`,
    '',
    '  final String group;',
    '  final Size? size;',
    ...(pseudo ? ['  final bool pseudo;'] : []),
    '',
    '  @override',
    '  List<Preview> get previews => const <Preview>[];',
    '',
    '  @override',
    '  List<Preview> transform() {',
    `    final template = ${dartLocale(templateLocale)};`,
    `    final rtl = ${cls}.supportedLocales.any(_isRtl);`,
    '    return <Preview>[',
    '      ...super.transform(),',
    `      for (final locale in ${cls}.supportedLocales)`,
    '        Preview(',
    '          group: group,',
    '          name: locale.toLanguageTag(),',
    '          size: size,',
    '          localizations: () => _localizations(locale),',
    ...(provider ? ['          wrapper: _provide,'] : []),
    '        ),',
    '      if (!rtl)',
    '        Preview(',
    '          group: group,',
    "          name: '${template.toLanguageTag()}, right to left',",
    '          size: size,',
    '          localizations: () => _localizations(template),',
    `          wrapper: (child) => Directionality(textDirection: TextDirection.rtl, child: ${provider ? '_provide(child)' : 'child'}),`,
    '        ),',
    ...(pseudo
      ? [
          '      if (pseudo)',
          '        Preview(',
          '          group: group,',
          "          name: 'Pseudo-locale (+40%)',",
          '          size: size,',
          '          localizations: () => _localizations(template, const _PseudoDelegate()),',
          ...(provider ? ['          wrapper: _provide,'] : []),
          '        ),',
        ]
      : []),
    '    ];',
    '  }',
    '}',
    '',
    `PreviewLocalizationsData _localizations(Locale locale, [LocalizationsDelegate<${cls}>? own]) =>`,
    '    PreviewLocalizationsData(',
    '      locale: locale,',
    `      supportedLocales: ${cls}.supportedLocales,`,
    `      localizationsDelegates: [if (own != null) own, ...${cls}.localizationsDelegates],`,
    '    );',
    '',
    "bool _isRtl(Locale l) => const {'ar', 'fa', 'he', 'ps', 'ur', 'ckb', 'dv', 'sd', 'ug', 'yi'}.contains(l.languageCode);",
  ];

  if (provider) {
    out.push(
      '',
      '// No initialize(): previews show the bundled ARB strings, without live updates.',
      'final _service = TranslationService();',
      '',
      'Widget _provide(Widget child) => Builder(',
      '      builder: (context) => TranslationProvider(',
      '        service: _service,',
      `        generatedLocalizations: ${cls}.of(context),`,
      '        child: child,',
      '      ),',
      '    );',
    );
  }

  if (pseudo) {
    out.push(
      '',
      `class _PseudoDelegate extends LocalizationsDelegate<${cls}> {`,
      '  const _PseudoDelegate();',
      '',
      '  @override',
      '  bool isSupported(Locale locale) => true;',
      '',
      '  @override',
      `  Future<${cls}> load(Locale locale) => SynchronousFuture(_Pseudo());`,
      '',
      '  @override',
      '  bool shouldReload(_PseudoDelegate old) => false;',
      '}',
      '',
      'const _accents = {',
      "  'a': 'á', 'c': 'ç', 'e': 'é', 'i': 'î', 'n': 'ñ', 'o': 'ö', 'u': 'ü', 'y': 'ý',",
      "  'A': 'Å', 'C': 'Ç', 'E': 'É', 'I': 'Î', 'N': 'Ñ', 'O': 'Ö', 'U': 'Ü', 'Y': 'Ý',",
      '};',
      '',
      '/// Accented and 40% longer, in brackets so a clipped end shows.',
      'String _p(String s) {',
      "  final accented = s.split('').map((c) => _accents[c] ?? c).join();",
      "  return '[$accented${'~' * (s.length * 0.4).ceil()}]';",
      '}',
      '',
      `class _Pseudo extends ${templateCls} {`,
    );
    for (const [i, m] of members!.entries()) {
      if (i) out.push('');
      out.push('  @override');
      out.push(
        m.params === undefined
          ? `  String get ${m.name} => _p(super.${m.name});`
          : `  String ${m.name}(${m.params}) => _p(super.${m.name}(${paramNames(m.params).join(', ')}));`,
      );
    }
    out.push('}');
  }
  return out.join('\n') + '\n';
}

export interface WidgetClass {
  name: string;
  /** Offset of `class`. */
  start: number;
  /** Offset just past the closing brace. */
  end: number;
}

/** Concrete classes in [src] whose superclass name ends in `Widget`. */
export function widgetClasses(src: string): WidgetClass[] {
  const out: WidgetClass[] = [];
  const re = /^(?:abstract\s+|final\s+|base\s+)*class\s+(_?[A-Z]\w*)(?:<[^{]*?>)?\s+extends\s+(\w+)[^{]*\{/gm;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (/^abstract\b/.test(m[0]) || !/Widget$/.test(m[2])) continue;
    const open = m.index + m[0].length - 1;
    const close = closingBrace(src, open);
    if (close < 0) continue;
    out.push({ name: m[1], start: m.index, end: close + 1 });
  }
  return out;
}

export const widgetClassAt = (src: string, offset: number): WidgetClass | undefined =>
  widgetClasses(src).find((c) => offset >= c.start && offset <= c.end);

/** Previews must be public, so `_Card` gives `cardLocalePreview`. */
export function previewFunctionName(widget: string): string {
  const name = widget.replace(/^_+/, '');
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}LocalePreview`;
}
