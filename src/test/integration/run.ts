import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../../..');
  // Work on a copy: the tests edit the fixture.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fl10n-it-'));
  fs.cpSync(path.join(root, 'fixtures/app'), workspace, { recursive: true });
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'suite'),
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust'],
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
