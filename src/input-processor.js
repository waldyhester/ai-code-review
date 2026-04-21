const path = require("path");
const he = require("he");
const shellQuote = require("shell-quote").quote;

const core = require("./core-wrapper");
const GitHubAPI = require("./github-api");
const OpenAIAgent = require("./openai-agent");
const AnthropicAgent = require("./anthropic-agent");
const GoogleAgent = require("./google-agent");
const DeepseekAgent = require("./deepseek-agent");
const XAgent = require("./x-agent");
const PerplexityAgent = require("./perplexity-agent");
const {
    AI_REVIEW_COMMENT_PREFIX,
    AI_REVIEW_NATIVE_MARKER,
    AI_REVIEW_INLINE_MARKER,
    SUMMARY_SEPARATOR,
    REASONING_CONTENT_SEPARATOR
} = require("./constants");

/* -------------------------------------------------------------------------- */
/*                               Sanitizers                                   */
/* -------------------------------------------------------------------------- */

function sanitizeString(value, { maxLen = 10_000, context = "none" } = {}) {
    if (value === null || value === undefined) {
        return "";
    }
    const str = String(value).trim().slice(0, maxLen);

    switch (context) {
        case "html":
            return he.encode(str, { useNamedReferences: true });
        case "shell":
            return shellQuote([str]);
        default:
            // eslint-disable-next-line no-control-regex
            return str.replace(/[\u0000-\u001F\u007F]/g, "");
    }
}

function sanitizeNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const num = Number(value);
    if (Number.isNaN(num)) {
        throw new TypeError("Expected a number");
    }
    return Math.min(Math.max(num, min), max);
}

function sanitizeBool(value) {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        return /^(true|1)$/i.test(value.trim());
    }
    return Boolean(value);
}

function sanitizePath(value) {
    if (value === null || value === undefined) {
        return "";
    }
    const str = String(value).trim();
    if (!str) {
        return "";
    }
    // eslint-disable-next-line no-control-regex
    const safe = str.replace(/[<>:"|?*\x00-\x1F]/g, "_");
    const normalized = path.posix.normalize(safe).replace(/^(\.\.(\/|\\|$))+/, "");
    return normalized === "." ? "" : normalized;
}

/* -------------------------------------------------------------------------- */
/*                               InputProcessor                               */
/* -------------------------------------------------------------------------- */

class InputProcessor {
    constructor() {
        this._repo = null;
        this._owner = null;
        this._pullNumber = null;
        this._githubToken = null;
        this._aiProvider = null;
        this._apiKey = null;
        this._model = null;
        this._failAction = true;
        this._githubAPI = null;
        this._baseCommit = null;
        this._headCommit = null;
        this._filteredDiffs = [];
        this._fileContentGetter = null;
        this._fileCommentator = null;
        this._reviewRulesFile = null;
        this._reviewRulesContent = null;
        this._pendingReviewComments = [];
    }

    /* ----------------------------- Public API ------------------------------ */

    async processInputs() {
        this._readInputs();
        this._validateInputs();
        await this._setupGitHubAPI();
        await this._processChangedFiles();
        await this._loadReviewRules(); // Load review rules after GitHub API is set up
        this._setupReviewTools();
        return this;
    }

    /* --------------------------- Private helpers --------------------------- */

    _readInputs() {
        this._repo = sanitizeString(core.getInput("repo", { required: true, trimWhitespace: true }));
        this._owner = sanitizeString(core.getInput("owner", { required: true, trimWhitespace: true }));
        this._pullNumber = sanitizeNumber(core.getInput("pr_number", { required: true, trimWhitespace: true }), { min: 1 });
        this._githubToken = sanitizeString(core.getInput("token", { required: true, trimWhitespace: true }));
        this._aiProvider = sanitizeString(core.getInput("ai_provider", { required: true, trimWhitespace: true })).toLowerCase();
        this._apiKey = sanitizeString(core.getInput(`${this._aiProvider}_api_key`, { required: true, trimWhitespace: true }));
        this._model = sanitizeString(core.getInput(`${this._aiProvider}_model`, { required: true, trimWhitespace: true }));
        this._failAction = sanitizeBool(core.getInput("fail_action_if_review_failed"));

        this._includeExtensions = sanitizeString(core.getInput("include_extensions"));
        this._excludeExtensions = sanitizeString(core.getInput("exclude_extensions"));
        this._includePaths = sanitizePath(core.getInput("include_paths"));
        this._excludePaths = sanitizePath(core.getInput("exclude_paths"));
        this._reviewRulesFile = sanitizePath(core.getInput("review_rules_file"));

        if (!this._includeExtensions) {
            core.info("Using default: include all extensions");
        }
        if (!this._excludeExtensions) {
            core.info("Using default: exclude no extensions");
        }
        if (!this._includePaths) {
            core.info("Using default: include all paths");
        }
        if (!this._excludePaths) {
            core.info("Using default: exclude no paths");
        }

        if (!this._reviewRulesFile) {
            core.info("No custom review rules file specified.");
        }
    }

    _validateInputs() {
        if (!this._repo) {
            throw new Error("Repository name is required.");
        }
        if (!this._owner) {
            throw new Error("Owner name is required.");
        }
        if (!this._pullNumber) {
            throw new Error("Pull request number must be a valid number.");
        }
        if (!this._githubToken) {
            throw new Error("GitHub token is required.");
        }
        if (!this._aiProvider) {
            throw new Error("AI provider is required.");
        }
        if (!this._apiKey) {
            throw new Error(`${this._aiProvider} API key is required.`);
        }

        const supportedProviders = ["openai", "anthropic", "google", "deepseek", "x", "perplexity"];
        if (!supportedProviders.includes(this._aiProvider)) {
            throw new Error(`Unsupported AI provider: ${this._aiProvider}. Supported providers: ${supportedProviders.join(", ")}`);
        }
    }

    async _setupGitHubAPI() {
        this._githubAPI = new GitHubAPI(this._githubToken);
        const pullRequestData = await this._githubAPI.getPullRequest(this._owner, this._repo, this._pullNumber);
        this._headCommit = pullRequestData.head.sha;
        this._baseCommit = pullRequestData.base.sha;
    }

    async _processChangedFiles() {
        const reviews = await this._githubAPI.listPRReviews(this._owner, this._repo, this._pullNumber);
        const lastNativeReview = [...reviews].reverse().find(review =>
            review &&
            typeof review.body === "string" &&
            review.body.includes(AI_REVIEW_NATIVE_MARKER) &&
            review.body.includes(AI_REVIEW_COMMENT_PREFIX)
        );

        let newBaseCommit = null;
        if (lastNativeReview) {
            core.info(`Found last native AI review: ${lastNativeReview.id}`);
            newBaseCommit = this._extractCommitHash(lastNativeReview.body);
        }

        if (!newBaseCommit) {
            const comments = await this._githubAPI.listPRComments(this._owner, this._repo, this._pullNumber);
            const lastLegacyComment = [...comments].reverse().find(comment =>
                comment &&
                typeof comment.body === "string" &&
                comment.body.startsWith(AI_REVIEW_COMMENT_PREFIX)
            );
            if (lastLegacyComment) {
                core.info(`Found last legacy AI review comment: ${lastLegacyComment.id}`);
                newBaseCommit = this._extractCommitHash(lastLegacyComment.body);
            }
        }

        if (newBaseCommit) {
            core.info(`New base commit ${newBaseCommit}. Incremental review will be performed`);
            this._baseCommit = newBaseCommit;
        } else {
            core.info("No previous AI review marker found, reviewing all files in PR");
        }

        const changedFiles = await this._githubAPI.getFilesBetweenCommits(
            this._owner,
            this._repo,
            this._baseCommit,
            this._headCommit
        );

        this._filteredDiffs = this._filterChangedFiles(
            changedFiles,
            this._includeExtensions,
            this._excludeExtensions,
            this._includePaths,
            this._excludePaths
        );

        core.info(`Found ${this._filteredDiffs.length} files to review`);
    }

    _filterChangedFiles(changedFiles, includeExtensions, excludeExtensions, includePaths, excludePaths) {
        const toArray = str => (str ? str.split(",").map(s => s.trim()).filter(Boolean) : []);

        const incExt = toArray(includeExtensions);
        const excExt = toArray(excludeExtensions);
        const incPath = toArray(includePaths);
        const excPath = toArray(excludePaths);

        const shouldReview = file => {
            const filePath = file.filename.replace(/\\/g, "/");
            const ext = path.posix.extname(filePath);

            const extAllowed = !incExt.length || incExt.includes(ext);
            const extExcluded = excExt.includes(ext);

            const inAllowedPath = !incPath.length || incPath.some(p => filePath.startsWith(p));
            const inExcludedPath = excPath.some(p => filePath.startsWith(p));

            return extAllowed && !extExcluded && inAllowedPath && !inExcludedPath;
        };

        return changedFiles.filter(shouldReview);
    }

    async _loadReviewRules() {
        if (this._reviewRulesFile) {
            core.info(`Attempting to load review rules from: ${this._reviewRulesFile}`);
            try {
                this._reviewRulesContent = await this._githubAPI.getContent(
                    this._owner,
                    this._repo,
                    this._headCommit, // Use head commit to get the latest version of the rules file
                    this._headCommit,
                    this._reviewRulesFile
                );
                core.info("Successfully loaded review rules.");
            } catch (error) {
                core.warning(`Could not load review rules from ${this._reviewRulesFile}: ${error.message}`);
                this._reviewRulesContent = null; // Ensure it's null if loading fails
            }
        }
    }

    _setupReviewTools() {
        this._fileContentGetter = filePath =>
            this._githubAPI.getContent(this._owner, this._repo, this._baseCommit, this._headCommit, filePath);

        this._fileCommentator = (comment, filePath, side, startLineNumber, endLineNumber) => {
            this._pendingReviewComments.push({
                path: filePath,
                body: `${AI_REVIEW_INLINE_MARKER}\n${comment}`,
                side,
                startLineNumber,
                endLineNumber
            });
        };
    }

    _extractCommitHash(text) {
        if (!text || typeof text !== "string") {
            return null;
        }

        const prefixMatch = text.match(/AI review done up to commit:\s*([a-f0-9]{7,40})/i);
        if (prefixMatch && prefixMatch[1]) {
            return prefixMatch[1];
        }

        return null;
    }

    async publishReview(reviewSummary, reasoningContent = "") {
        const reviewBodyParts = [
            AI_REVIEW_NATIVE_MARKER,
            `${AI_REVIEW_COMMENT_PREFIX}${this._headCommit}${SUMMARY_SEPARATOR}${reviewSummary}`
        ];

        if (reasoningContent && typeof reasoningContent === "string" && reasoningContent.trim()) {
            reviewBodyParts.push(`${REASONING_CONTENT_SEPARATOR}${reasoningContent.trim()}`);
        }

        const reviewBody = reviewBodyParts.join("\n");
        await this._githubAPI.cleanupAIGeneratedArtifacts(
            this._owner,
            this._repo,
            this._pullNumber,
            AI_REVIEW_NATIVE_MARKER,
            AI_REVIEW_INLINE_MARKER,
            AI_REVIEW_COMMENT_PREFIX
        );
        await this._githubAPI.createPRReview(
            this._owner,
            this._repo,
            this._pullNumber,
            this._headCommit,
            reviewBody,
            this._pendingReviewComments
        );
    }

    /* ----------------------------- AI agent -------------------------------- */
    getAIAgent() {
        switch (this._aiProvider) {
            case "openai":
                return new OpenAIAgent(this._apiKey, this._fileContentGetter, this._fileCommentator, this._model, this._reviewRulesContent);
            case "anthropic":
                return new AnthropicAgent(this._apiKey, this._fileContentGetter, this._fileCommentator, this._model, this._reviewRulesContent);
            case "google":
                return new GoogleAgent(this._apiKey, this._fileContentGetter, this._fileCommentator, this._model, this._reviewRulesContent);
            case "deepseek":
                return new DeepseekAgent(this._apiKey, this._fileContentGetter, this._fileCommentator, this._model, this._reviewRulesContent);
            case "x":
                return new XAgent(this._apiKey, this._fileContentGetter, this._fileCommentator, this._model, this._reviewRulesContent);
            case "perplexity":
                return new PerplexityAgent(this._apiKey, this._fileContentGetter, this._fileCommentator, this._model, this._reviewRulesContent);
            default:
                throw new Error(`Unsupported AI provider: ${this._aiProvider}`);
        }
    }

    /* ------------------------------ Getters -------------------------------- */

    get filteredDiffs() { return this._filteredDiffs; }
    get githubAPI() { return this._githubAPI; }
    get headCommit() { return this._headCommit; }
    get repo() { return this._repo; }
    get owner() { return this._owner; }
    get pullNumber() { return this._pullNumber; }
    get failAction() { return this._failAction; }
}

module.exports = InputProcessor;
