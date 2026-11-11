import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { tokenize } from '../../core/dartLexer';
import { findHardcodedStrings, stringAt } from '../../core/hardcoded';

const found = (src: string): string[] => findHardcodedStrings(src).map((c) => c.message);

test('Text and label-like arguments are reported', () => {
  const src = `
Widget build(BuildContext context) => Column(children: [
  const Text('Welcome back'),
  Text("Sign in"),
  TextField(decoration: InputDecoration(labelText: 'Email address', hintText: 'you@example.com')),
  IconButton(tooltip: 'Delete item', onPressed: null, icon: Icon(Icons.delete)),
  SelectableText('Copy me'),
]);`;
  assert.deepEqual(found(src), ['Welcome back', 'Sign in', 'Email address', 'Delete item', 'Copy me']);
});

test('strings that are not shown to the user are ignored', () => {
  const src = `
import 'package:flutter/material.dart';
final routes = {'/home': (c) => Home()};
void f() {
  print('debug message here');
  Navigator.pushNamed(context, '/settings');
  Image.asset('assets/logo.png');
  final key = Key('submit_button');
  log(label: 'not in an argument list?');
  final x = cond ? label : 'Ternary text';
  Text('');
  Text('42');
  Text(variable);
}`;
  // label: inside log( is an argument list, so it counts; the ternary does not.
  assert.deepEqual(found(src), ['not in an argument list?']);
});

test('comments, raw and triple quoted strings are skipped', () => {
  const src = `
// Text('commented out')
/* Text('block /* nested */ comment') */
Text(r'Raw text here'),
Text('''Multi
line'''),`;
  assert.deepEqual(found(src), []);
});

test('l10n-ignore on the line or the line above', () => {
  const src = `
Text('Brand Name'), // l10n-ignore
// l10n-ignore
Text('Other Brand'),
Text('Translate me'),`;
  assert.deepEqual(found(src), ['Translate me']);
});

test('concatenations and adjacent literals are not single messages', () => {
  assert.deepEqual(found(`Text('Hello ' + name)`), []);
  assert.deepEqual(found(`Text('Hello ' 'world')`), []);
});

test('interpolations become placeholders', () => {
  const [c] = findHardcodedStrings(`Text('Hello $name, you have \${cart.items.length} items and \${count + 1} more')`);
  assert.equal(c.message, 'Hello {name}, you have {itemsLength} items and {value} more');
  assert.deepEqual(c.placeholders, [
    { name: 'name', expr: 'name' },
    { name: 'itemsLength', expr: 'cart.items.length' },
    { name: 'value', expr: 'count + 1' },
  ]);
});

test('widget. and this. prefixes do not end up in the placeholder name', () => {
  const [c] = findHardcodedStrings(`Text('Hi \${widget.user}')`);
  assert.equal(c.placeholders[0].name, 'user');
});

test('repeated placeholder names get a suffix', () => {
  const [c] = findHardcodedStrings(`Text('\${a + 1} of \${b + 2}')`);
  assert.deepEqual(c.placeholders.map((p) => p.name), ['value', 'value2']);
});

test('escapes are decoded and braces in text are refused', () => {
  assert.deepEqual(found(`Text('It\\'s done')`), ["It's done"]);
  assert.deepEqual(found(`Text('Use {curly} braces')`), []);
});

test('every enclosing const is located', () => {
  assert.deepEqual(findHardcodedStrings(`const Text('Remove const')`)[0].constStarts, [0]);
  const nested = `const Padding(padding: EdgeInsets.zero, child: Text('Inner'))`;
  assert.deepEqual(findHardcodedStrings(nested)[0].constStarts, [0]);
  const list = `Column(children: const <Widget>[SizedBox(), Text('In list')])`;
  assert.deepEqual(findHardcodedStrings(list)[0].constStarts, [list.indexOf('const')]);
  const body = `Widget build(c) { const x = 1; return Text('Not const'); }`;
  assert.deepEqual(findHardcodedStrings(body)[0].constStarts, []);
  const sibling = `Column(children: [const SizedBox(), Text('Plain')])`;
  assert.deepEqual(findHardcodedStrings(sibling)[0].constStarts, []);
});

test('stringAt finds any literal under the cursor', () => {
  const src = `final title = 'Shop now';`;
  const c = stringAt(src, src.indexOf('Shop'));
  assert.equal(c?.message, 'Shop now');
  assert.equal(stringAt(src, 0), undefined);
});

test('nested strings inside interpolation do not end the outer literal', () => {
  const src = `Text('A \${map['key']} B'), Text('Next')`;
  assert.deepEqual(found(src), ['A {value} B', 'Next']);
  const strings = tokenize(src).filter((t) => t.kind === 'string');
  assert.equal(strings.length, 2);
});

test('unicode escapes', () => {
  assert.deepEqual(found(`Text('Caf\\u00e9 \\u{1F600}')`), ['Café 😀']);
});
