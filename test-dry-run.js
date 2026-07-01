const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

async function withMockedFileActions(run) {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kimi-dryrun-'));

    const vscodeMock = {
        Uri: {
            file: (fsPath) => ({ fsPath: path.resolve(fsPath) })
        },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
            asRelativePath: (uri) => path.relative(workspaceRoot, uri.fsPath),
            fs: {
                readFile: async (uri) => fs.readFile(uri.fsPath),
                writeFile: async (uri, data) => {
                    await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
                    await fs.writeFile(uri.fsPath, Buffer.from(data));
                }
            }
        }
    };

    const originalLoad = Module._load;
    const fileActionsPath = path.resolve(__dirname, 'out', 'actions', 'fileActions.js');
    const projectActionsPath = path.resolve(__dirname, 'out', 'actions', 'projectActions.js');

    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'vscode') {
            return vscodeMock;
        }
        return originalLoad.apply(this, arguments);
    };

    delete require.cache[fileActionsPath];
    delete require.cache[projectActionsPath];

    try {
        const fileActions = require(fileActionsPath);
        return await run({ workspaceRoot, fileActions });
    } finally {
        Module._load = originalLoad;
        delete require.cache[fileActionsPath];
        delete require.cache[projectActionsPath];
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
}

test('simulateWriteTextFile does not write to disk and returns expected dry-run message', async () => {
    await withMockedFileActions(async ({ workspaceRoot, fileActions }) => {
        const relativePath = path.join('sandbox', 'dry-write.txt');
        const absolutePath = path.join(workspaceRoot, relativePath);

        const result = await fileActions.simulateWriteTextFile(relativePath, 'new simulated content');

        assert.equal(result.message, '[Dry-Run] Modification simulee avec succes');
        assert.equal(result.action, 'write_file');
        await assert.rejects(() => fs.access(absolutePath));
    });
});

test('simulateAppendTextFile simulates append from missing file with empty initial content', async () => {
    await withMockedFileActions(async ({ fileActions }) => {
        const result = await fileActions.simulateAppendTextFile('missing/append.txt', 'hello');

        assert.equal(result.action, 'append_file');
        assert.equal(result.beforeLength, 0);
        assert.equal(result.afterLength, 5);
        assert.equal(result.changed, true);
        assert.equal(result.beforePreview, '');
        assert.equal(result.afterPreview, 'hello');
    });
});

test('simulateReplaceInFile reports occurrences without altering workspace content', async () => {
    await withMockedFileActions(async ({ workspaceRoot, fileActions }) => {
        const relativePath = 'replace/source.txt';
        const absolutePath = path.join(workspaceRoot, relativePath);
        const initial = 'alpha beta alpha gamma';
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, initial, 'utf8');

        const result = await fileActions.simulateReplaceInFile(relativePath, 'alpha', 'omega');
        const afterOnDisk = await fs.readFile(absolutePath, 'utf8');

        assert.equal(result.action, 'replace');
        assert.equal(result.occurrences, 2);
        assert.equal(result.changed, true);
        assert.equal(afterOnDisk, initial);
    });
});

test('real write/append/replace operations still mutate files when not in dry-run path', async () => {
    await withMockedFileActions(async ({ workspaceRoot, fileActions }) => {
        const relativePath = 'real/mutate.txt';
        const absolutePath = path.join(workspaceRoot, relativePath);

        await fileActions.writeTextFile(relativePath, 'A');
        assert.equal(await fs.readFile(absolutePath, 'utf8'), 'A');

        await fileActions.appendTextFile(relativePath, 'B');
        assert.equal(await fs.readFile(absolutePath, 'utf8'), 'AB');

        const replaced = await fileActions.replaceInFile(relativePath, 'AB', 'XYZ');
        assert.equal(replaced.replaced, true);
        assert.equal(await fs.readFile(absolutePath, 'utf8'), 'XYZ');
    });
});