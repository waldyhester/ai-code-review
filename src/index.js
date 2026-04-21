const InputProcessor = require("./input-processor");
const core = require("./core-wrapper");
const main = async () => {
    const inputProcessor = new InputProcessor();

    try {
        await inputProcessor.processInputs();

        if (inputProcessor.filteredDiffs.length === 0) {
            core.info('No files to review');
            return;
        }
        
        const aiAgent = inputProcessor.getAIAgent();
        const reviewSummary = await aiAgent.doReview(inputProcessor.filteredDiffs);
        if (!reviewSummary || typeof reviewSummary !== 'string' || reviewSummary.trim() === '') {
            throw new Error('AI Agent did not return a valid review summary');
        }

        const reasoningContent = typeof aiAgent.getReasoningContent === "function"
            ? aiAgent.getReasoningContent()
            : "";
        await inputProcessor.publishReview(reviewSummary, reasoningContent);

    } catch (error) {
        if (inputProcessor.failAction) {            
            core.debug(error.stack);
            core.error(error.message);
            core.setFailed(error);
        } else {
            core.debug(error.stack);
            core.warning(error.message);
        }
    }
};

main();
