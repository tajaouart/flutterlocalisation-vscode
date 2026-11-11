import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

const root = path.resolve(__dirname, '../../..');
// flutter is a .bat on Windows, which only runs through a shell.
const shell = process.platform === 'win32';

function copyFixture(settings: Record<string, unknown>): string {
  // Work on a copy: the tests edit the fixture.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fl10n-it-'));
  fs.cpSync(path.join(root, 'fixtures/app'), workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.vscode/settings.json'), JSON.stringify(settings, null, 2));
  return workspace;
}

function hasFlutter(): boolean {
  try {
    execFileSync('flutter', ['--version'], { stdio: 'ignore', shell });
    return true;
  } catch {
    return false;
  }
}

async function suite(name: string, workspace: string): Promise<void> {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'suite'),
    extensionTestsEnv: { FL10N_SUITE: name },
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust'],
  });
}

async function main(): Promise<void> {
  await suite('editor', copyFixture({ 'flutterL10n.generateOnSave': false }));
  if (hasFlutter()) {
    const app = copyFixture({ 'flutterL10n.generateOnSave': true });
    execFileSync('flutter', ['pub', 'get'], { cwd: app, stdio: 'inherit', shell });
    await suite('flutter', app);
  } else if (process.env.CI) {
    throw new Error('flutter is not on the PATH; the generation suite cannot run.');
  } else {
    console.warn('flutter not found: skipping the generation suite.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
