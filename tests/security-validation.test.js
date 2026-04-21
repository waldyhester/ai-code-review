"use strict";

jest.mock("../src/core-wrapper", () => ({
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
}));

const { AI_REVIEW_COMMENT_PREFIX, SUMMARY_SEPARATOR } = require("../src/constants");
const InputProcessor = require("../src/input-processor");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const VALID_SHA_A = "a".repeat(40);
const VALID_SHA_B = "b".repeat(40);
const HEAD_SHA   = "c".repeat(40);

/** Build a minimal GitHubAPI mock. */
function makeMockGitHubAPI({
    comments = [],
    prCommits = [],
    permLevel = "write",
    permError = null,
    ancestryError = null,
    changedFiles = [],
} = {}) {
    return {
        listPRComments: jest.fn().mockResolvedValue(comments),
        listPRCommits: ancestryError
            ? jest.fn().mockRejectedValue(new Error(ancestryError))
            : jest.fn().mockResolvedValue(prCommits),
        getCollaboratorPermissionLevel: permError
            ? jest.fn().mockRejectedValue(new Error(permError))
            : jest.fn().mockResolvedValue(permLevel),
        getFilesBetweenCommits: jest.fn().mockResolvedValue(changedFiles),
    };
}

/** Build a review comment body with the correct format. */
function reviewCommentBody(sha, authorLogin = "bot") {
    return {
        body: `${AI_REVIEW_COMMENT_PREFIX}${sha}${SUMMARY_SEPARATOR}Some review summary`,
        user: { login: authorLogin },
    };
}

/** Create an InputProcessor with all private fields pre-populated. */
function makeProcessor(overrides = {}) {
    const p = new InputProcessor();
    p._owner = "myorg";
    p._repo  = "myrepo";
    p._pullNumber = 7;
    p._baseCommit = VALID_SHA_B;   // original base from PR
    p._headCommit = HEAD_SHA;
    p._includeExtensions = "";
    p._excludeExtensions = "";
    p._includePaths = "";
    p._excludePaths = "";

    p._githubAPI = makeMockGitHubAPI(overrides);
    return p;
}

// ---------------------------------------------------------------------------
// _processChangedFiles — security validation
// ---------------------------------------------------------------------------
describe("InputProcessor._processChangedFiles — incremental base hardening", () => {
    test("no previous review comment → keeps original baseCommit", async () => {
        const p = makeProcessor({ comments: [] });
        const original = p._baseCommit;

        await p._processChangedFiles();

        expect(p._baseCommit).toBe(original);
        expect(p._githubAPI.listPRCommits).not.toHaveBeenCalled();
        expect(p._githubAPI.getCollaboratorPermissionLevel).not.toHaveBeenCalled();
    });

    test("valid SHA, in PR commits, author has write → updates baseCommit", async () => {
        const p = makeProcessor({
            comments: [reviewCommentBody(VALID_SHA_A, "alice")],
            prCommits: [{ sha: VALID_SHA_A }],
            permLevel: "write",
        });

        await p._processChangedFiles();

        expect(p._baseCommit).toBe(VALID_SHA_A);
    });

    test("valid SHA, in PR commits, author has admin → updates baseCommit", async () => {
        const p = makeProcessor({
            comments: [reviewCommentBody(VALID_SHA_A, "admin-user")],
            prCommits: [{ sha: VALID_SHA_A }],
            permLevel: "admin",
        });

        await p._processChangedFiles();

        expect(p._baseCommit).toBe(VALID_SHA_A);
    });

    test("valid SHA, in PR commits, author has maintain → updates baseCommit", async () => {
        const p = makeProcessor({
            comments: [reviewCommentBody(VALID_SHA_A, "maintainer")],
            prCommits: [{ sha: VALID_SHA_A }],
            permLevel: "maintain",
        });

        await p._processChangedFiles();

        expect(p._baseCommit).toBe(VALID_SHA_A);
    });

    test("malformed SHA (too short) → fallback, ancestry check skipped", async () => {
        const shortSha = "abc123";
        const comment = reviewCommentBody(shortSha, "alice");
        const p = makeProcessor({ comments: [comment] });
        const original = p._baseCommit;

        await p._processChangedFiles();

        expect(p._baseCommit).toBe(original);
        expect(p._githubAPI.listPRCommits).not.toHaveBeenCalled();
    });

    test("valid format but SHA not in PR commits → fallback", async () => {
        const otherSha = "d".repeat(40);
        const p = makeProcessor({
            comments: [reviewCommentBody(VALID_SHA_A, "alice")],
            prCommits: [{ sha: otherSha }],  // VALID_SHA_A not in list
            permLevel: "write",
        });
        const original = p._baseCommit;

        await p._processChangedFiles();

        expect(p._baseCommit).toBe(original);
        expect(p._githubAPI.getCollaboratorPermissionLevel).not.toHaveBeenCalled();
    });

    test("valid SHA, in PR commits, author has only read permission → fallback", async () => {
        const p = makeProcessor({
            comments: [reviewCommentBody(VALID_SHA_A, "reader")],
            prCommits: [{ sha: VALID_SHA_A }],
            permLevel: "read",
        });
        const original = p._baseCommit;

        await p._processChangedFiles();

        expect(p._baseCommit).toBe(original);
    });

    test("valid SHA, in PR commits, author has none permission → fallback", async () => {
        const p = makeProcessor({
            comments: [reviewCommentBody(VALID_SHA_A, "outsider")],
            prCommits: [{ sha: VALID_SHA_A }],
            permLevel: "none",
        });
        const original = p._baseCommit;

        await p._processChangedFiles();

        expect(p._baseCommit).toBe(original);
    });

    test("ancestry check throws → fallback (safe default)", async () => {
        const p = makeProcessor({
            comments: [reviewCommentBody(VALID_SHA_A, "alice")],
            ancestryError: "Service unavailable",
        });
        const original = p._baseCommit;

        await p._processChangedFiles();

        expect(p._baseCommit).toBe(original);
    });

    test("permission check throws → fallback (safe default)", async () => {
        const p = makeProcessor({
            comments: [reviewCommentBody(VALID_SHA_A, "alice")],
            prCommits: [{ sha: VALID_SHA_A }],
            permError: "Permission API down",
        });
        const original = p._baseCommit;

        await p._processChangedFiles();

        expect(p._baseCommit).toBe(original);
    });

    test("comment with no user login → fallback", async () => {
        const p = makeProcessor({
            comments: [{
                body: `${AI_REVIEW_COMMENT_PREFIX}${VALID_SHA_A}${SUMMARY_SEPARATOR}summary`,
                user: null,   // no user info
            }],
            prCommits: [{ sha: VALID_SHA_A }],
            permLevel: "write",
        });
        const original = p._baseCommit;

        await p._processChangedFiles();

        expect(p._baseCommit).toBe(original);
    });

    test("uses the most recent review comment when multiple exist", async () => {
        const olderSha = "e".repeat(40);
        const newerSha = VALID_SHA_A;

        const p = makeProcessor({
            comments: [
                reviewCommentBody(olderSha, "alice"),  // older (index 0)
                reviewCommentBody(newerSha, "alice"),  // newer (index 1, reversed → first found)
            ],
            prCommits: [{ sha: olderSha }, { sha: newerSha }],
            permLevel: "write",
        });

        await p._processChangedFiles();

        // The code does [...comments].reverse().find(...), so newerSha (last in array) wins
        expect(p._baseCommit).toBe(newerSha);
    });
});

// ---------------------------------------------------------------------------
// _setupReviewTools — knownPatch integration
// ---------------------------------------------------------------------------
describe("InputProcessor._setupReviewTools — knownPatch forwarding", () => {
    test("passes patch string for a file that is in filteredDiffs", () => {
        const p = makeProcessor();
        p._filteredDiffs = [
            { filename: "src/app.js", patch: "@@ -1 +1 @@" },
        ];
        const mockGetContent = jest.fn().mockResolvedValue("content");
        p._githubAPI.getContent = mockGetContent;

        p._setupReviewTools();
        p._fileContentGetter("src/app.js");

        expect(mockGetContent).toHaveBeenCalledWith(
            p._owner, p._repo, p._baseCommit, p._headCommit,
            "src/app.js",
            "@@ -1 +1 @@"   // knownPatch forwarded
        );
    });

    test("passes null for a binary file (no patch property) in filteredDiffs", () => {
        const p = makeProcessor();
        p._filteredDiffs = [
            { filename: "img.png" },  // no patch property → binary
        ];
        const mockGetContent = jest.fn().mockResolvedValue("[Binary file not shown in review]");
        p._githubAPI.getContent = mockGetContent;

        p._setupReviewTools();
        p._fileContentGetter("img.png");

        expect(mockGetContent).toHaveBeenCalledWith(
            p._owner, p._repo, p._baseCommit, p._headCommit,
            "img.png",
            null   // explicitly null → binary
        );
    });

    test("passes undefined for a file NOT in filteredDiffs (triggers fallback in getContent)", () => {
        const p = makeProcessor();
        p._filteredDiffs = [];  // empty — file is not in the diff
        const mockGetContent = jest.fn().mockResolvedValue("content");
        p._githubAPI.getContent = mockGetContent;

        p._setupReviewTools();
        p._fileContentGetter("rules.md");

        expect(mockGetContent).toHaveBeenCalledWith(
            p._owner, p._repo, p._baseCommit, p._headCommit,
            "rules.md",
            undefined  // undefined → fallback inside getContent
        );
    });
});
