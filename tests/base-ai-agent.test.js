"use strict";

jest.mock("../src/core-wrapper", () => ({
    info: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
}));

jest.mock("../src/constants", () => ({
    MAX_CACHE_ENTRIES: 5,
    LINE_SPAN: 0,
}));

const BaseAIAgent = require("../src/base-ai-agent");
const { SimpleMutex } = BaseAIAgent;

// ---------------------------------------------------------------------------
// Helper: create a minimal BaseAIAgent concrete instance
// ---------------------------------------------------------------------------
function makeAgent(getterFn = jest.fn()) {
    // BaseAIAgent is abstract; create an anonymous subclass
    class TestAgent extends BaseAIAgent {
        initialize() { return true; }
        doReview() { return Promise.resolve(""); }
    }
    return new TestAgent("key", getterFn, jest.fn(), "test-model", null);
}

// ---------------------------------------------------------------------------
// validateLineNumbers
// ---------------------------------------------------------------------------
describe("BaseAIAgent.validateLineNumbers", () => {
    let agent;

    beforeEach(() => {
        agent = makeAgent();
    });

    test("returns null for equal start and end (single line)", () => {
        expect(agent.validateLineNumbers(5, 5)).toBeNull();
    });

    test("returns null when start < end", () => {
        expect(agent.validateLineNumbers(1, 10)).toBeNull();
    });

    test("error when start is not an integer", () => {
        expect(agent.validateLineNumbers(1.5, 5)).toMatch(/Start line/);
    });

    test("error when start is less than 1", () => {
        expect(agent.validateLineNumbers(0, 5)).toMatch(/Start line/);
    });

    test("error when end is not an integer", () => {
        expect(agent.validateLineNumbers(1, 2.7)).toMatch(/End line/);
    });

    test("error when end is less than 1", () => {
        expect(agent.validateLineNumbers(1, 0)).toMatch(/End line/);
    });

    test("error when start > end", () => {
        expect(agent.validateLineNumbers(10, 5)).toMatch(/greater/);
    });

    test("error when negative numbers provided", () => {
        expect(agent.validateLineNumbers(-1, -1)).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// getFileContentWithCache
// ---------------------------------------------------------------------------
describe("BaseAIAgent.getFileContentWithCache", () => {
    test("fetches content on first call and caches it", async () => {
        const getter = jest.fn().mockResolvedValue("line1\nline2\nline3");
        const agent = makeAgent(getter);

        await agent.getFileContentWithCache("file.js", 1, 3);

        expect(getter).toHaveBeenCalledTimes(1);
        expect(agent.fileCache.has("file.js")).toBe(true);
    });

    test("uses cache on second call — getter not invoked again", async () => {
        const getter = jest.fn().mockResolvedValue("a\nb\nc");
        const agent = makeAgent(getter);

        await agent.getFileContentWithCache("file.js", 1, 3);
        await agent.getFileContentWithCache("file.js", 1, 3);

        expect(getter).toHaveBeenCalledTimes(1);
    });

    test("different files are cached independently", async () => {
        const getter = jest.fn()
            .mockResolvedValueOnce("content A")
            .mockResolvedValueOnce("content B");
        const agent = makeAgent(getter);

        await agent.getFileContentWithCache("a.js", 1, 1);
        await agent.getFileContentWithCache("b.js", 1, 1);

        expect(getter).toHaveBeenCalledTimes(2);
        expect(agent.fileCache.size).toBe(2);
    });

    test("evicts oldest entry when cache exceeds MAX_CACHE_ENTRIES (5)", async () => {
        const getter = jest.fn().mockResolvedValue("x\ny\nz");
        const agent = makeAgent(getter);

        // Fill cache to the limit
        for (let i = 1; i <= 5; i++) {
            await agent.getFileContentWithCache(`file${i}.js`, 1, 1);
        }
        expect(agent.fileCache.size).toBe(5);
        expect(agent.fileCache.has("file1.js")).toBe(true);

        // 6th entry triggers eviction of the oldest (file1)
        await agent.getFileContentWithCache("file6.js", 1, 1);

        expect(agent.fileCache.size).toBe(5);
        expect(agent.fileCache.has("file1.js")).toBe(false);
        expect(agent.fileCache.has("file6.js")).toBe(true);
    });

    test("throws on non-string path", async () => {
        const agent = makeAgent();
        await expect(agent.getFileContentWithCache(null, 1, 1)).rejects.toThrow("Invalid file path");
        await expect(agent.getFileContentWithCache(123, 1, 1)).rejects.toThrow("Invalid file path");
    });

    test("throws on invalid line numbers", async () => {
        const agent = makeAgent();
        await expect(agent.getFileContentWithCache("f.js", 0, 1)).rejects.toThrow("Invalid line numbers");
        await expect(agent.getFileContentWithCache("f.js", 5, 3)).rejects.toThrow("Invalid line numbers");
        await expect(agent.getFileContentWithCache("f.js", 1.5, 2)).rejects.toThrow("Invalid line numbers");
    });

    test("returned content includes line numbers", async () => {
        const getter = jest.fn().mockResolvedValue("alpha\nbeta\ngamma");
        const agent = makeAgent(getter);

        const result = await agent.getFileContentWithCache("f.js", 1, 3);
        expect(result).toContain("1:");
        expect(result).toContain("alpha");
    });
});

// ---------------------------------------------------------------------------
// SimpleMutex
// ---------------------------------------------------------------------------
describe("SimpleMutex", () => {
    test("acquire resolves immediately when unlocked", async () => {
        const mutex = new SimpleMutex();
        await expect(mutex.acquire()).resolves.toBeUndefined();
        mutex.release();
    });

    test("second acquire blocks until release", async () => {
        const mutex = new SimpleMutex();
        await mutex.acquire();

        let resolved = false;
        const p = mutex.acquire().then(() => { resolved = true; });

        // Still locked — should not have resolved yet
        await Promise.resolve(); // flush microtask queue
        expect(resolved).toBe(false);

        mutex.release(); // unblock p
        await p;
        expect(resolved).toBe(true);
        mutex.release();
    });

    test("acquire times out when mutex is held", async () => {
        const mutex = new SimpleMutex();
        await mutex.acquire();

        await expect(mutex.acquire(50)).rejects.toThrow("Timeout while waiting for cache lock");

        mutex.release();
    });

    test("multiple waiters resolved in FIFO order", async () => {
        const mutex = new SimpleMutex();
        const order = [];

        await mutex.acquire(); // hold the lock

        const p1 = mutex.acquire().then(() => { order.push(1); mutex.release(); });
        const p2 = mutex.acquire().then(() => { order.push(2); mutex.release(); });
        const p3 = mutex.acquire().then(() => { order.push(3); mutex.release(); });

        mutex.release(); // trigger p1

        await Promise.all([p1, p2, p3]);

        expect(order).toEqual([1, 2, 3]);
    });
});
