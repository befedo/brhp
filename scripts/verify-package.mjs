import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);
const packageJsonPath = new URL('../package.json', import.meta.url);
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));

assert(packageJson.type === 'module', 'package.json must declare type=module');
assert(
  Array.isArray(packageJson['oc-plugin']) &&
    packageJson['oc-plugin'].includes('server') &&
    packageJson['oc-plugin'].includes('tui'),
  'oc-plugin must include server and tui'
);
assert(packageJson.exports?.['.']?.import, 'root import export is missing');
assert(packageJson.exports?.['./tui']?.import, 'tui import export is missing');
assert(
  packageJson.exports['./tui'].import === './dist/tui/index.js',
  'tui import export must reference Bun-built artifact'
);

const rootEntry = path.join(rootPath, 'dist', 'src', 'index.js');
const rootTypes = path.join(rootPath, 'dist', 'src', 'index.d.ts');
const tuiEntry = path.join(rootPath, 'dist', 'tui', 'index.js');
const tuiTypes = path.join(rootPath, 'dist', 'src', 'tui', 'index.d.ts');

await access(rootEntry);
await access(rootTypes);
await access(tuiEntry);
await access(tuiTypes);

const serverModule = await import(pathToFileURL(rootEntry).href);
const tuiModule = await import(pathToFileURL(tuiEntry).href);

assertServerModule(serverModule, 'server default export');
assertTuiModule(tuiModule, 'tui default export');

await smokeServerModule(serverModule, rootPath);
await smokeTuiModule(tuiModule, rootPath);

await verifyLocalFilePackageSpec();
await verifyPackedArtifact();

console.log('Package verification passed');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertServerModule(module, label) {
  assert(module.default?.id === 'brhp', `${label} must expose plugin id`);
  assert(typeof module.default?.setup === 'function', `${label} must expose setup function`);
}

function assertTuiModule(module, label) {
  assert(module.default?.id === 'brhp', `${label} must expose plugin id`);
  assert(typeof module.default?.setup === 'function', `${label} must expose setup function`);
}

async function smokeServerModule(module, worktreePath) {
  const registeredTools = [];
  const registeredCommands = [];
  const registeredHooks = [];
  let brhpCommand;
  let promptText;

  const context = {
    location: {
      directory: worktreePath,
      project: { id: 'global', directory: worktreePath, canonical: worktreePath },
    },
    tool: {
      transform: cb => {
        const editor = {
          add: def => {
            registeredTools.push(def.name);
          },
        };
        cb(editor);
        return { dispose: () => {} };
      },
    },
    command: {
      transform: cb => {
        const editor = {
          add: def => {
            registeredCommands.push(def.name);
            if (def.name === 'brhp') {
              brhpCommand = def;
            }
          },
        };
        cb(editor);
        return { dispose: () => {} };
      },
    },
    session: {
      hook: (name, cb) => {
        registeredHooks.push(name);
        return { dispose: () => {} };
      },
      prompt: async input => {
        promptText = input.text;
        return {};
      },
    },
  };

  const cleanup = await module.default.setup(context);
  assert(typeof cleanup === 'function', 'server setup must return a cleanup function');

  const expectedTools = [
    'brhp_get_active_plan',
    'brhp_decompose_node',
    'brhp_validate_active_scope',
    'brhp_complete_leaf',
    'brhp_query_nodes',
    'brhp_get_node',
    'brhp_search_nodes',
  ];
  for (const tool of expectedTools) {
    assert(registeredTools.includes(tool), `server must register ${tool} tool`);
  }
  assert(registeredCommands.includes('brhp'), 'server must register brhp command');
  assert(registeredHooks.includes('context'), 'server must register context system prompt hook');
  assert(brhpCommand, 'brhp command definition must be captured');

  // Invoke /brhp inspect end-to-end through the V2 command execute path.
  await brhpCommand.execute({
    sessionID: 'package-smoke-session',
    prompt: { text: '/brhp inspect', files: [] },
    delivery: 'steer',
  });
  assert(
    String(promptText).includes('# BRHP Inspect'),
    'server brhp inspect command must render inspect output'
  );

  await cleanup();
}

async function smokeTuiModule(module, worktreePath) {
  const claims = [];
  let layers = 0;

  const context = {
    location: { directory: worktreePath },
    theme: {
      current: {
        text: { base: '#000000', muted: '#666666', feedback: { error: { base: '#ff0000' } } },
        background: { base: '#ffffff' },
        border: { base: '#cccccc' },
      },
    },
    ui: {
      slot: claim => {
        claims.push(claim);
        return () => claims.push(`un:${claim.append}`);
      },
      toast: { show: () => {} },
    },
    keymap: {
      layer: () => {
        layers += 1;
      },
    },
  };

  const cleanup = await module.default.setup(context);
  assert(typeof cleanup === 'function', 'tui setup must return a cleanup function');

  assert(
    claims.some(c => c.append === 'sidebar.content'),
    'tui plugin must register sidebar.content slot'
  );
  assert(layers >= 1, 'tui plugin must register a keymap layer');

  await cleanup();
}

async function verifyLocalFilePackageSpec() {
  const serverEntry = resolveLocalPackageEntrypoint('server');
  const localTuiEntry = resolveLocalPackageEntrypoint('tui');

  assert(serverEntry, 'local file package spec must resolve a server entrypoint');
  assert(localTuiEntry, 'local file package spec must resolve a tui entrypoint');

  const localServerModule = await import(pathToFileURL(serverEntry).href);
  const localTuiModule = await import(pathToFileURL(localTuiEntry).href);

  assertServerModule(localServerModule, 'local file package server export');
  assertTuiModule(localTuiModule, 'local file package tui export');
  await smokeServerModule(localServerModule, rootPath);
  await smokeTuiModule(localTuiModule, rootPath);
}

function resolveLocalPackageEntrypoint(kind) {
  const exported = packageJson.exports?.[`./${kind}`];
  const exportedPath = exportValue(exported);

  if (exportedPath) {
    return resolvePackagePath(exportedPath);
  }

  if (kind === 'server' && typeof packageJson.main === 'string' && packageJson.main.trim()) {
    return resolvePackagePath(packageJson.main);
  }
}

function exportValue(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return undefined;
  }

  for (const key of ['import', 'default']) {
    if (typeof value[key] === 'string' && value[key].trim()) {
      return value[key];
    }
  }
}

function resolvePackagePath(packageRelativePath) {
  const resolved = path.resolve(rootPath, packageRelativePath);
  const root = path.resolve(rootPath);

  assert(
    resolved === root || resolved.startsWith(`${root}${path.sep}`),
    `package entry '${packageRelativePath}' must stay inside package root`
  );

  return resolved;
}

async function verifyPackedArtifact() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'brhp-package-'));

  try {
    const packResult = await runCommand(
      'npm',
      ['pack', '--ignore-scripts', '--dry-run=false', '--json', '--pack-destination', tempRoot],
      rootPath
    );
    const packed = JSON.parse(packResult.stdout);
    const entries = Array.isArray(packed) ? packed : Object.values(packed);
    const [{ filename }] = entries;

    assert(typeof filename === 'string' && filename.length > 0, 'npm pack did not return a filename');

    const tarballPath = path.join(tempRoot, filename);
    await access(tarballPath);

    const installRoot = path.join(tempRoot, 'install');
    await mkdir(installRoot);
    await writeFile(
      path.join(installRoot, 'package.json'),
      JSON.stringify({ name: 'brhp-smoke-test', private: true, type: 'module' }, null, 2)
    );

    await runCommand('npm', ['install', '--ignore-scripts', '--dry-run=false', tarballPath], installRoot);

    const installedPackageRoot = path.join(installRoot, 'node_modules', packageJson.name);
    await access(path.join(installedPackageRoot, 'dist', 'src', 'index.js'));
    await access(path.join(installedPackageRoot, 'dist', 'src', 'index.d.ts'));
    await access(path.join(installedPackageRoot, 'dist', 'tui', 'index.js'));
    await access(path.join(installedPackageRoot, 'dist', 'src', 'tui', 'index.d.ts'));

    const smokeScript = path.join(installRoot, 'smoke.mjs');
    await writeFile(
      smokeScript,
      `import serverModule from 'brhp';
import tuiModule from 'brhp/tui';

if (serverModule?.id !== 'brhp') throw new Error('server export missing id');
if (typeof serverModule?.setup !== 'function') throw new Error('server export missing setup function');
if (tuiModule?.id !== 'brhp') throw new Error('tui export missing id');
if (typeof tuiModule?.setup !== 'function') throw new Error('tui export missing setup function');

const registeredTools = [];
const registeredCommands = [];
let promptText;

const context = {
  location: {
    directory: ${JSON.stringify(installRoot)},
    project: { id: 'global', directory: ${JSON.stringify(installRoot)}, canonical: ${JSON.stringify(installRoot)} },
  },
  tool: {
    transform: cb => {
      const editor = { add: def => { registeredTools.push(def.name); } };
      cb(editor);
      return { dispose: () => {} };
    },
  },
  command: {
    transform: cb => {
      const editor = { add: def => { registeredCommands.push(def.name); } };
      cb(editor);
      return { dispose: () => {} };
    },
  },
  session: {
    hook: () => ({ dispose: () => {} }),
    prompt: async input => { promptText = input.text; return {}; },
  },
};

const cleanup = await serverModule.setup(context);
if (typeof cleanup !== 'function') throw new Error('server setup must return cleanup');

const expectedTools = ['brhp_get_active_plan','brhp_decompose_node','brhp_validate_active_scope','brhp_complete_leaf','brhp_query_nodes','brhp_get_node','brhp_search_nodes'];
for (const tool of expectedTools) {
  if (!registeredTools.includes(tool)) throw new Error(\`server missing \${tool} tool\`);
}
if (!registeredCommands.includes('brhp')) throw new Error('server missing brhp command');

const tuiContext = {
  location: { directory: ${JSON.stringify(installRoot)} },
  theme: { current: { text: { base: '#000000', muted: '#666666', feedback: { error: { base: '#ff0000' } } }, background: { base: '#ffffff' }, border: { base: '#cccccc' } } },
  ui: { slot: () => () => {}, toast: { show: () => {} } },
  keymap: { layer: () => {} },
};

const tuiCleanup = await tuiModule.setup(tuiContext);
if (typeof tuiCleanup !== 'function') throw new Error('tui setup must return cleanup');
await tuiCleanup();

await cleanup();
`
    );

    await runCommand('bun', [smokeScript], installRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} failed\n${stderr || stdout}`));
    });
  });
}
