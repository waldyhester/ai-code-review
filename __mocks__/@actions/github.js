// Minimal CJS stub for @actions/github used by Jest.
// Tests override this via jest.mock() or by calling getOctokit.mockReturnValue().
const getOctokit = jest.fn();
const context = {};
module.exports = { getOctokit, context };
