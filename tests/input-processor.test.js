"use strict";

jest.mock("../src/core-wrapper", () => ({
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    getInput: jest.fn(() => ""),
}));

const InputProcessor = require("../src/input-processor");
const {
    _sanitizeString: sanitizeString,
    _sanitizeBool: sanitizeBool,
    _sanitizePath: sanitizePath,
} = InputProcessor;

// ---------------------------------------------------------------------------
// sanitizeString
// ---------------------------------------------------------------------------
describe("sanitizeString", () => {
    test("returns empty string for null", () => {
        expect(sanitizeString(null)).toBe("");
    });

    test("returns empty string for undefined", () => {
        expect(sanitizeString(undefined)).toBe("");
    });

    test("truncates to maxLen (default 10 000)", () => {
        const long = "a".repeat(20_000);
        expect(sanitizeString(long).length).toBe(10_000);
    });

    test("truncates to custom maxLen", () => {
        expect(sanitizeString("hello world", { maxLen: 5 })).toBe("hello");
    });

    test("removes control characters by default", () => {
        expect(sanitizeString("hello\x00world\x1F")).toBe("helloworld");
    });

    test("html context encodes special characters", () => {
        const result = sanitizeString("<script>alert('xss')</script>", { context: "html" });
        expect(result).not.toContain("<");
        expect(result).not.toContain(">");
    });

    test("shell context wraps in quotes", () => {
        const result = sanitizeString("hello world", { context: "shell" });
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
    });

    test("converts non-string values to string", () => {
        expect(sanitizeString(42)).toBe("42");
        expect(sanitizeString(true)).toBe("true");
    });

    test("trims leading and trailing whitespace", () => {
        expect(sanitizeString("  hello  ")).toBe("hello");
    });
});

// ---------------------------------------------------------------------------
// sanitizeBool
// ---------------------------------------------------------------------------
describe("sanitizeBool", () => {
    test.each([
        [true, true],
        [false, false],
    ])("native boolean %p → %p", (input, expected) => {
        expect(sanitizeBool(input)).toBe(expected);
    });

    test.each([
        ["true", true],
        ["True", true],
        ["TRUE", true],
        ["1", true],
    ])("truthy string %p → true", (input, expected) => {
        expect(sanitizeBool(input)).toBe(expected);
    });

    test.each([
        ["false", false],
        ["False", false],
        ["FALSE", false],
        ["0", false],
        ["no", false],
        ["", false],
    ])("falsy string %p → false", (input, expected) => {
        expect(sanitizeBool(input)).toBe(expected);
    });

    test("numeric 0 → false", () => {
        expect(sanitizeBool(0)).toBe(false);
    });

    test("numeric 1 → true", () => {
        expect(sanitizeBool(1)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// sanitizePath
// ---------------------------------------------------------------------------
describe("sanitizePath", () => {
    test("returns empty string for null", () => {
        expect(sanitizePath(null)).toBe("");
    });

    test("returns empty string for undefined", () => {
        expect(sanitizePath(undefined)).toBe("");
    });

    test("returns empty string for empty string", () => {
        expect(sanitizePath("")).toBe("");
    });

    test("blocks path traversal (../)", () => {
        const result = sanitizePath("../../../etc/passwd");
        expect(result).not.toContain("..");
    });

    test("replaces invalid characters", () => {
        const result = sanitizePath("file<>.js");
        expect(result).not.toContain("<");
        expect(result).not.toContain(">");
    });

    test("returns normalized normal path", () => {
        const result = sanitizePath("src/utils.js");
        expect(result).toBe("src/utils.js");
    });

    test("returns empty string for '.' after normalization", () => {
        expect(sanitizePath(".")).toBe("");
    });
});

// ---------------------------------------------------------------------------
// InputProcessor._filterChangedFiles
// ---------------------------------------------------------------------------
describe("InputProcessor._filterChangedFiles", () => {
    let processor;

    beforeEach(() => {
        processor = new InputProcessor();
    });

    const makeFiles = (...paths) =>
        paths.map(p => ({ filename: p }));

    test("no filters → returns all files", () => {
        const files = makeFiles("src/a.js", "src/b.ts", "README.md");
        expect(processor._filterChangedFiles(files, "", "", "", "")).toHaveLength(3);
    });

    test("includeExtensions filters to matching extensions only", () => {
        const files = makeFiles("a.js", "b.ts", "c.js");
        const result = processor._filterChangedFiles(files, ".js", "", "", "");
        expect(result.map(f => f.filename)).toEqual(["a.js", "c.js"]);
    });

    test("excludeExtensions removes matching extensions", () => {
        const files = makeFiles("a.js", "b.md", "c.js");
        const result = processor._filterChangedFiles(files, "", ".md", "", "");
        expect(result.map(f => f.filename)).toEqual(["a.js", "c.js"]);
    });

    test("includePaths restricts to files inside the path", () => {
        const files = makeFiles("src/a.js", "vendor/b.js", "src/c.js");
        const result = processor._filterChangedFiles(files, "", "", "src/", "");
        expect(result.map(f => f.filename)).toEqual(["src/a.js", "src/c.js"]);
    });

    test("excludePaths removes files inside the path", () => {
        const files = makeFiles("src/a.js", "vendor/b.js", "src/c.js");
        const result = processor._filterChangedFiles(files, "", "", "", "vendor/");
        expect(result.map(f => f.filename)).toEqual(["src/a.js", "src/c.js"]);
    });

    test("combine includeExtensions and excludeExtensions", () => {
        const files = makeFiles("a.js", "b.ts", "c.js", "d.md");
        // include .js and .ts, then exclude .ts
        const result = processor._filterChangedFiles(files, ".js,.ts", ".ts", "", "");
        expect(result.map(f => f.filename)).toEqual(["a.js", "c.js"]);
    });

    test("combine includePaths and excludePaths", () => {
        const files = makeFiles("src/a.js", "src/vendor/b.js", "lib/c.js");
        const result = processor._filterChangedFiles(files, "", "", "src/", "src/vendor/");
        expect(result.map(f => f.filename)).toEqual(["src/a.js"]);
    });

    test("file without extension with an extension filter is excluded", () => {
        const files = makeFiles("Makefile", "src/a.js");
        const result = processor._filterChangedFiles(files, ".js", "", "", "");
        expect(result.map(f => f.filename)).toEqual(["src/a.js"]);
    });
});
