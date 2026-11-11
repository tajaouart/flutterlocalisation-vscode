import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

export type Mode = 'gen-l10n' | 'flutter_localisation' | 'intl_utils';

export interface L10nProject {
  root: string;
  packageName: string;
  mode: Mode;
  /** Absolute folder holding the ARB files. */
  arbDir: string;
  /** Absolute path of the template ARB. */
  templateArb: string;
  /** Absolute folder the localizations class is generated into. */
  outputDir: string;
  /** Generated file that declares [className]. */
  outputFile: string;
  className: string;
  /** gen-l10n's `nullable-getter` (true unless set to false). */
  nullableGetter: boolean;
}

type Yaml = Record<string, unknown>;

function readYaml(file: string): Yaml | undefined {
  try {
    const v = parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? (v as Yaml) : undefined;
  } catch {
    return undefined;
  }
}

const str = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v.trim() ? v.trim() : fallback;

const hasDep = (pubspec: Yaml, name: string): boolean =>
  ['dependencies', 'dev_dependencies'].some((s) => {
    const deps = pubspec[s];
    return !!deps && typeof deps === 'object' && name in (deps as Yaml);
  });

/** The nearest folder at or above [file] that holds a pubspec.yaml. */
export function findRoot(file: string, stopAt?: string): string | undefined {
  let dir = path.dirname(file);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pubspec.yaml'))) return dir;
    const up = path.dirname(dir);
    if (up === dir || (stopAt && !up.startsWith(stopAt))) return undefined;
    dir = up;
  }
}

/** Reads the localization setup of the app at [root], or undefined if it has none. */
export function loadProject(root: string): L10nProject | undefined {
  const pubspec = readYaml(path.join(root, 'pubspec.yaml'));
  if (!pubspec) return undefined;
  const packageName = str(pubspec.name, path.basename(root));

  const intl = pubspec.flutter_intl as Yaml | undefined;
  if (intl && typeof intl === 'object' && intl.enabled !== false) {
    const arbDir = path.join(root, str(intl.arb_dir, 'lib/l10n'));
    const outputDir = path.join(root, str(intl.output_dir, 'lib/generated'));
    return {
      root,
      packageName,
      mode: 'intl_utils',
      arbDir,
      templateArb: path.join(arbDir, `intl_${str(intl.main_locale, 'en')}.arb`),
      outputDir,
      outputFile: path.join(outputDir, 'l10n.dart'),
      className: str(intl.class_name, 'S'),
      nullableGetter: false,
    };
  }

  const l10nYaml = path.join(root, 'l10n.yaml');
  if (!fs.existsSync(l10nYaml)) return undefined;
  const cfg = readYaml(l10nYaml) ?? {};
  const arbDir = path.join(root, str(cfg['arb-dir'], 'lib/l10n'));
  const outputDir = cfg['output-dir'] ? path.join(root, str(cfg['output-dir'], '')) : arbDir;
  return {
    root,
    packageName,
    mode: hasDep(pubspec, 'flutter_localisation') &&
      fs.existsSync(path.join(root, 'lib', 'generated_translation_methods.dart'))
      ? 'flutter_localisation'
      : 'gen-l10n',
    arbDir,
    templateArb: path.join(arbDir, str(cfg['template-arb-file'], 'app_en.arb')),
    outputDir,
    outputFile: path.join(outputDir, str(cfg['output-localization-file'], 'app_localizations.dart')),
    className: str(cfg['output-class'], 'AppLocalizations'),
    nullableGetter: cfg['nullable-getter'] !== false,
  };
}

/** `package:` URI of [file] when it sits under lib/, otherwise undefined. */
export function packageUri(project: L10nProject, file: string): string | undefined {
  const rel = path.relative(path.join(project.root, 'lib'), file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return `package:${project.packageName}/${rel.split(path.sep).join('/')}`;
}

export interface Accessor {
  /** Expression for a message getter, `{key}` replaced by the key. */
  template: string;
  /** Imports the expression needs. */
  imports: string[];
}

export function accessorFor(project: L10nProject, override?: string): Accessor {
  if (override && override.includes('{key}')) return { template: override, imports: [] };
  if (project.mode === 'flutter_localisation') {
    const methods = packageUri(project, path.join(project.root, 'lib', 'generated_translation_methods.dart'));
    return {
      template: 'context.tr.{key}',
      imports: ['package:flutter_localisation/flutter_localisation.dart', ...(methods ? [methods] : [])],
    };
  }
  const uri = packageUri(project, project.outputFile);
  const bang = project.mode === 'gen-l10n' && project.nullableGetter ? '!' : '';
  return {
    template: `${project.className}.of(context)${bang}.{key}`,
    imports: uri ? [uri] : [],
  };
}

/** The command that regenerates the Dart after an ARB change. */
export function generateCommand(project: L10nProject, flutter: string): { cmd: string; args: string[] } {
  if (project.mode === 'intl_utils') {
    return { cmd: dartFor(flutter), args: ['run', 'intl_utils:generate'] };
  }
  if (project.mode === 'flutter_localisation') {
    // The package generator takes the ARB root and the flavor folder.
    const rel = path.relative(project.root, project.arbDir).split(path.sep).filter(Boolean);
    const flavor = rel.length > 1 ? rel[rel.length - 1] : 'Default';
    const arbRoot = rel.length > 1 ? rel.slice(0, -1).join('/') : rel.join('/');
    return { cmd: dartFor(flutter), args: ['run', 'flutter_localisation', arbRoot, flavor] };
  }
  return { cmd: flutter, args: ['gen-l10n'] };
}

function dartFor(flutter: string): string {
  if (flutter === 'flutter') return 'dart';
  const sibling = path.join(path.dirname(flutter), process.platform === 'win32' ? 'dart.bat' : 'dart');
  return fs.existsSync(sibling) ? sibling : 'dart';
}
