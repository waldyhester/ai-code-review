"use strict";

// Mock @actions/github with a factory that exposes getOctokit as a jest.fn()
jest.mock("@actions/github", () => ({ getOctokit: jest.fn() }));

jest.mock("../src/core-wrapper", () => ({
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
}));

const github = require("@actions/github");
const GitHubAPI = require("../src/github-api");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeOctokit(overrides = {}) {
    return {
        rest: {
            repos: {
                getContent: jest.fn(),
                compareCommits: jest.fn(),
                getCollaboratorPermissionLevel: jest.fn(),
            },
            pulls: {
                get: jest.fn(),
                listCommits: jest.fn(),
                createReviewComment: jest.fn(),
            },
            issues: {
                listComments: jest.fn(),
                createComment: jest.fn(),
            },
        },
        paginate: jest.fn(),
        ...overrides,
    };
}

function base64(str) {
    return Buffer.from(str).toString("base64");
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
let mockOctokit;
let api;

beforeEach(() => {
    mockOctokit = makeOctokit();
    github.getOctokit.mockReturnValue(mockOctokit);
    api = new GitHubAPI("fake-token");
    jest.clearAllMocks();
    // Re-set return value after clearAllMocks
    github.getOctokit.mockReturnValue(mockOctokit);
    api = new GitHubAPI("fake-token");
});

// ---------------------------------------------------------------------------
// getContent
// ---------------------------------------------------------------------------
describe("GitHubAPI.getContent", () => {
    test("returns decoded text when knownPatch is a non-null string", async () => {
        const fileContent = "console.log('hello');";
        mockOctokit.rest.repos.getContent.mockResolvedValue({
            data: {
                type: "file",
                size: 21,
                content: base64(fileContent),
                encoding: "base64",
            },
        });

        const result = await api.getContent("o", "r", "base", "head", "file.js", "@@ patch @@");

        expect(result).toBe(fileContent);
        // compareCommits should NOT have been called since knownPatch was provided
        expect(mockOctokit.rest.repos.compareCommits).not.toHaveBeenCalled();
    });

    test("returns binary message when knownPatch is null", async () => {
        mockOctokit.rest.repos.getContent.mockResolvedValue({
            data: {
                type: "file",
                size: 100,
                content: base64("binary"),
                encoding: "base64",
            },
        });

        const result = await api.getContent("o", "r", "base", "head", "img.png", null);

        expect(result).toBe("[Binary file not shown in review]");
        expect(mockOctokit.rest.repos.compareCommits).not.toHaveBeenCalled();
    });

    test("calls compareCommits when knownPatch is undefined and returns text for file with patch", async () => {
        const fileContent = "const x = 1;";
        mockOctokit.rest.repos.getContent.mockResolvedValue({
            data: {
                type: "file",
                size: 12,
                content: base64(fileContent),
                encoding: "base64",
            },
        });
        mockOctokit.rest.repos.compareCommits.mockResolvedValue({
            data: { files: [{ filename: "src/index.js", patch: "@@ -1 +1 @@" }] },
        });

        const result = await api.getContent("o", "r", "base", "head", "src/index.js");

        expect(result).toBe(fileContent);
        expect(mockOctokit.rest.repos.compareCommits).toHaveBeenCalledTimes(1);
    });

    test("returns binary when compareCommits file entry has no patch", async () => {
        mockOctokit.rest.repos.getContent.mockResolvedValue({
            data: {
                type: "file",
                size: 200,
                content: base64("binarydata"),
                encoding: "base64",
            },
        });
        mockOctokit.rest.repos.compareCommits.mockResolvedValue({
            data: { files: [{ filename: "image.png" }] }, // no patch property
        });

        const result = await api.getContent("o", "r", "base", "head", "image.png");

        expect(result).toBe("[Binary file not shown in review]");
    });

    test("returns directory listing for array response", async () => {
        mockOctokit.rest.repos.getContent.mockResolvedValue({
            data: [
                { name: "src", type: "dir" },
                { name: "package.json", type: "file" },
            ],
        });

        const result = await api.getContent("o", "r", "base", "head", ".");

        expect(result).toMatch(/\[Directory content:/);
        expect(result).toContain("src/");
        expect(result).toContain("package.json");
    });

    test("returns skip message for files exceeding MAX_FILE_SIZE_BYTES", async () => {
        mockOctokit.rest.repos.getContent.mockResolvedValue({
            data: {
                type: "file",
                size: 2 * 1024 * 1024, // 2 MB > 1 MB limit
                content: base64("x"),
                encoding: "base64",
            },
        });

        const result = await api.getContent("o", "r", "base", "head", "huge.bin");

        expect(result).toMatch(/too large/i);
    });

    test("returns error string when API throws", async () => {
        mockOctokit.rest.repos.getContent.mockRejectedValue(new Error("Network error"));

        const result = await api.getContent("o", "r", "base", "head", "missing.js");

        expect(result).toMatch(/Error retrieving file content/);
        expect(result).toMatch(/Network error/);
    });

    test("falls back to metadata-based detection when compareCommits fails", async () => {
        const fileContent = "let y = 2;";
        mockOctokit.rest.repos.getContent.mockResolvedValue({
            data: {
                type: "file",
                size: 10,
                content: base64(fileContent),
                encoding: "base64",
                truncated: false,
            },
        });
        mockOctokit.rest.repos.compareCommits.mockRejectedValue(new Error("API down"));

        const result = await api.getContent("o", "r", "base", "head", "y.js");

        // Should fall back to metadata: content present + base64 + not truncated → text
        expect(result).toBe(fileContent);
    });

    test("returns [file not shown] for non-file types", async () => {
        mockOctokit.rest.repos.getContent.mockResolvedValue({
            data: { type: "symlink" },
        });

        const result = await api.getContent("o", "r", "base", "head", "link");

        expect(result).toBe("[symlink not shown]");
    });
});

// ---------------------------------------------------------------------------
// getFilesBetweenCommits
// ---------------------------------------------------------------------------
describe("GitHubAPI.getFilesBetweenCommits", () => {
    test("returns files array from comparison", async () => {
        mockOctokit.rest.repos.compareCommits.mockResolvedValue({
            data: {
                files: [
                    { filename: "a.js", status: "modified", patch: "@@ -1,1 +1,1 @@" },
                    { filename: "b.png", status: "added" },
                ],
            },
        });

        const result = await api.getFilesBetweenCommits("o", "r", "base", "head");

        expect(result).toHaveLength(2);
        expect(result[0].filename).toBe("a.js");
        expect(result[1].filename).toBe("b.png");
    });

    test("returns empty array when comparison.files is undefined", async () => {
        mockOctokit.rest.repos.compareCommits.mockResolvedValue({
            data: {}, // no files property
        });

        const result = await api.getFilesBetweenCommits("o", "r", "base", "head");

        expect(result).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// listPRCommits
// ---------------------------------------------------------------------------
describe("GitHubAPI.listPRCommits", () => {
    test("paginates and returns all commits", async () => {
        const fakeCommits = [{ sha: "abc" }, { sha: "def" }];
        mockOctokit.paginate.mockResolvedValue(fakeCommits);

        const result = await api.listPRCommits("o", "r", 42);

        expect(mockOctokit.paginate).toHaveBeenCalledWith(
            mockOctokit.rest.pulls.listCommits,
            { owner: "o", repo: "r", pull_number: 42 }
        );
        expect(result).toEqual(fakeCommits);
    });
});

// ---------------------------------------------------------------------------
// getCollaboratorPermissionLevel
// ---------------------------------------------------------------------------
describe("GitHubAPI.getCollaboratorPermissionLevel", () => {
    test("returns the permission level string", async () => {
        mockOctokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
            data: { permission: "write" },
        });

        const result = await api.getCollaboratorPermissionLevel("o", "r", "alice");

        expect(result).toBe("write");
        expect(mockOctokit.rest.repos.getCollaboratorPermissionLevel).toHaveBeenCalledWith({
            owner: "o",
            repo: "r",
            username: "alice",
        });
    });
});
