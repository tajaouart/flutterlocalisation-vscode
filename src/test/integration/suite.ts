import * as path from 'path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', timeout: 120000, color: true });
  const file = process.env.FL10N_SUITE === 'flutter' ? 'generation.test.js' : 'extension.test.js';
  mocha.addFile(path.join(__dirname, file));
  return new Promise((resolve, reject) =>
    mocha.run((failures) => (failures ? reject(new Error(`${failures} integration test(s) failed`)) : resolve())),
  );
}
