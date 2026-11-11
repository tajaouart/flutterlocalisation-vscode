# Changelog

## 0.1.0

- Hardcoded user-facing strings in `lib/` are reported (`Text`, `SelectableText`, `TextSpan`, and label-like
  arguments such as `labelText`, `hintText`, `tooltip`, `title`). `// l10n-ignore` skips a line.
- Quick fix and `Cmd+Alt+E` / `Ctrl+Alt+E`: extract a string to the template ARB. Interpolations become
  placeholders, `const` that would stop compiling is removed, the import is added, and an existing key with the
  same text is reused.
- Works with gen-l10n (`l10n.yaml`), the `flutter_localisation` package (`context.tr`) and intl_utils / Flutter
  Intl projects (`S.of(context)`).
- Regenerates the localizations when an ARB file is saved.
- Hover over a message getter to see its text in every locale.
- Locale ARB files warn about keys the template has and they do not.
