import { StreamableMCPServer } from "../src/modules/streamableMCPServer";
import {
  DeferredNotifierCommitter,
  flushWriteOperations,
  runSerializedWrite,
} from "../src/modules/deferredNotifierCommitter";

declare const expect: Chai.ExpectStatic;

const WRITE_ENABLED_PREF = "extensions.zotero.zotero-mcp-plugin.write.enabled";

describe("MCP write operations", function () {
  it("returns after the database commit when a notifier observer is slow", async function () {
    this.timeout(5000);

    (globalThis as any).ztoolkit = { log: () => undefined };
    const server = new StreamableMCPServer();
    const title = `MCP slow-notifier regression ${Date.now()}`;
    let itemKey: string | undefined;
    let observerStarted = false;
    let observerCompleted = false;
    let notifiedIDs: Array<string | number> = [];

    Zotero.Prefs.set(WRITE_ENABLED_PREF, true, true);

    const observerID = Zotero.Notifier.registerObserver(
      {
        notify: async (
          _event: string,
          _type: string,
          ids: Array<string | number>,
        ) => {
          observerStarted = true;
          notifiedIDs = ids;
          await Zotero.Promise.delay(1000);
          observerCompleted = true;
        },
      },
      ["item"],
      `mcp-slow-notifier-test-${Date.now()}`,
      1,
    );

    try {
      const startedAt = Date.now();
      const response = await server.handleMCPRequest(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "write_item",
            arguments: {
              action: "create",
              itemType: "journalArticle",
              fields: { title },
            },
          },
        }),
      );
      const elapsedMs = Date.now() - startedAt;

      const envelope = JSON.parse(response.body);
      const result = JSON.parse(envelope.result.content[0].text);
      itemKey = result.data.itemKey;
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        Zotero.Libraries.userLibraryID,
        itemKey,
      );

      if (!result.success) {
        throw {
          message: `write failed: ${JSON.stringify(result)}`,
          actual: result,
          expected: { success: true },
        };
      }
      if (!observerStarted) {
        throw {
          message: "target notifier observer did not run",
          actual: observerStarted,
          expected: true,
        };
      }
      expect(item?.getField("title")).to.equal(title);
      expect(notifiedIDs).to.include(item!.id);
      expect(result.metadata.notificationStatus).to.equal("pending");
      if (elapsedMs >= 600) {
        throw {
          message: `write response took ${elapsedMs} ms while waiting for a slow observer`,
          actual: elapsedMs,
          expected: "< 600",
        };
      }

      await Zotero.Promise.delay(1100);
      expect(observerCompleted).to.equal(true);
    } catch (error) {
      const diagnostic =
        error && typeof error === "object"
          ? {
              ...(error as Record<string, unknown>),
              message:
                (error as { message?: string }).message ||
                JSON.stringify(error),
            }
          : { message: String(error) };
      throw diagnostic;
    } finally {
      Zotero.Notifier.unregisterObserver(observerID);
      if (itemKey) {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(
          Zotero.Libraries.userLibraryID,
          itemKey,
        );
        if (item) {
          await item.eraseTx({ skipNotifier: true });
        }
      }
    }
  });

  it("does not hold collection creation on a slow notifier observer", async function () {
    this.timeout(5000);

    (globalThis as any).ztoolkit = { log: () => undefined };
    const server = new StreamableMCPServer();
    let collectionKey: string | undefined;
    let observerStarted = false;
    let observerCompleted = false;

    Zotero.Prefs.set(WRITE_ENABLED_PREF, true, true);

    const observerID = Zotero.Notifier.registerObserver(
      {
        notify: async () => {
          observerStarted = true;
          await Zotero.Promise.delay(1000);
          observerCompleted = true;
        },
      },
      ["collection"],
      `mcp-slow-collection-notifier-test-${Date.now()}`,
      1,
    );

    try {
      const startedAt = Date.now();
      const response = await server.handleMCPRequest(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "create_collection",
            arguments: { name: `MCP notifier test ${Date.now()}` },
          },
        }),
      );
      const elapsedMs = Date.now() - startedAt;

      const envelope = JSON.parse(response.body);
      const result = JSON.parse(envelope.result.content[0].text);
      collectionKey = result.key;
      const collection = await Zotero.Collections.getByLibraryAndKeyAsync(
        Zotero.Libraries.userLibraryID,
        collectionKey,
      );

      expect(collection?.name).to.match(/^MCP notifier test /);
      expect(result.notificationStatus).to.equal("pending");
      expect(observerStarted).to.equal(true);
      expect(elapsedMs).to.be.lessThan(600);

      await Zotero.Promise.delay(1100);
      expect(observerCompleted).to.equal(true);
    } finally {
      Zotero.Notifier.unregisterObserver(observerID);
      if (collectionKey) {
        const collection = await Zotero.Collections.getByLibraryAndKeyAsync(
          Zotero.Libraries.userLibraryID,
          collectionKey,
        );
        if (collection) {
          await collection.eraseTx({ skipNotifier: true });
        }
      }
    }
  });

  it("reports notifier failures without rejecting the serialized chain", async function () {
    const logs: string[] = [];
    const committer = new DeferredNotifierCommitter(50, (message) => {
      logs.push(message);
    });

    const result = await committer.enqueue("rejected test queue", async () => {
      throw new Error("observer failure");
    });

    expect(result.status).to.equal("failed");
    expect(result.error).to.contain("observer failure");
    expect(logs).to.have.length(1);
    expect(await committer.flush(50)).to.equal(true);
  });

  it("serializes overlapping Zotero write handlers", async function () {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runSerializedWrite(async () => {
      events.push("first-start");
      await firstGate;
      events.push("first-end");
    });
    const second = runSerializedWrite(async () => {
      events.push("second-start");
      events.push("second-end");
    });

    await Zotero.Promise.delay(20);
    expect(events).to.deep.equal(["first-start"]);

    const drain = flushWriteOperations(200);
    let drained = false;
    drain.then(() => {
      drained = true;
    });
    await Zotero.Promise.delay(20);
    expect(drained).to.equal(false);

    releaseFirst();
    await Promise.all([first, second]);
    expect(await drain).to.equal(true);
    expect(events).to.deep.equal([
      "first-start",
      "first-end",
      "second-start",
      "second-end",
    ]);
  });
});
