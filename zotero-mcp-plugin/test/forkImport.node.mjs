import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSync } from 'esbuild';

const bundle = buildSync({
  entryPoints: ['src/modules/streamableMCPServer.ts'],
  bundle: true, platform: 'node', format: 'esm', write: false,
}).outputFiles[0].text;
const { StreamableMCPServer } = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`);

function fixture({ missingFile = false, missingCollection = false, importError = false } = {}) {
  const saved = [], imports = [], collections = [], commits = [];
  globalThis.ztoolkit = { log() {} };
  globalThis.IOUtils = { exists: async () => !missingFile };
  globalThis.Zotero = {
    Libraries: { userLibraryID: 1 },
    Collections: { getByLibraryAndKeyAsync: async () => missingCollection ? null : {} },
    Notifier: { Queue: class {}, commit: async q => { commits.push(q); } },
    Item: class {
      key = 'CREATED'; id = 42; dateAdded = '2026-09-13';
      setField() {}
      async saveTx(options) { saved.push(options); }
    },
    Attachments: { importFromFile: async options => {
      imports.push(options);
      if (importError) throw new Error('import failed');
      return { key: `ATT${imports.length}`, getField: () => options.title };
    } },
  };
  const server = Object.create(StreamableMCPServer.prototype);
  server.callAddItemsToCollection = async args => { collections.push(args); return { success: true }; };
  return { server, saved, imports, collections, commits };
}

test('create retains multiple local files and collection targeting with deferred notifications', async () => {
  const f = fixture();
  const result = await f.server.callWriteItem({ action: 'create', itemType: 'document', filePaths: ['/tmp/a.pdf', '/tmp/b.md'], collectionKeys: ['COLL'] });
  assert.equal(result.success, true);
  assert.equal(result.data.importedAttachments.length, 2);
  assert.deepEqual(f.collections[0], { libraryID: 1, collectionKey: 'COLL', itemKeys: ['CREATED'] });
  assert.equal(result.metadata.notificationStatus, 'completed');
  for (const imported of f.imports) {
    assert.equal(imported.parentItemID, 42);
    assert.equal(imported.saveOptions.notifierQueue, f.saved[0].notifierQueue);
    assert.equal(imported.saveOptions.skipSelect, true);
  }
  assert.equal(f.commits[0], f.saved[0].notifierQueue);
});

test('single filePath retains caller attachment title', async () => {
  const f = fixture();
  const result = await f.server.callWriteItem({ action: 'create', itemType: 'document', filePath: '/tmp/a.pdf', title: 'Paper' });
  assert.equal(result.success, true);
  assert.equal(f.imports[0].title, 'Paper');
});

for (const option of ['missingFile', 'missingCollection']) {
  test(`invalid ${option} is rejected before creating the item`, async () => {
    const f = fixture({ [option]: true });
    const result = await f.server.callWriteItem({ action: 'create', itemType: 'document', filePath: '/tmp/a.pdf', collectionKeys: ['COLL'] });
    assert.equal(result.success, false);
    assert.equal(f.saved.length, 0);
    assert.equal(f.imports.length, 0);
  });
}

test('attachment failure flushes notification for the already-created item', async () => {
  const f = fixture({ importError: true });
  const result = await f.server.callWriteItem({ action: 'create', itemType: 'document', filePath: '/tmp/a.pdf' });
  assert.equal(result.success, false);
  assert.match(result.error, /import failed/);
  assert.equal(f.commits[0], f.saved[0].notifierQueue);
});
