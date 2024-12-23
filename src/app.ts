#!/usr/bin/env node
import { askAI } from "./askAI";
import { input, confirm, password } from "@inquirer/prompts";
import chalk from "chalk";
import { getAIEditsFromClaude } from "./call-ai-claude";
import { getAIEditsFromGPT } from "./call-ai-gpt";
import { processFiles } from "./process-files";
import fs from "node:fs";
import { EditProcessor } from "./edit-processor";
import { countTokens } from "@anthropic-ai/tokenizer";
import { taskPrompt } from "./prompt";
import { models, preferredVerifierModel } from "./models";
import { getAIEditsFromFireworks } from "./call-fireworks";
import { verifyEditStream } from "./verify-edits";
import { checkAPIKey, getAndSetAPIKey } from "./apiKeyUtils";
import { revertLastChanges } from "./edit-history";

function listAvailableModels() {
  console.log(
    "\nAvailable models:",
    models.map((model) => model.nickName).join(", ")
  );
  console.log(
    "\nYou can append the model nickname to the end of your command to use a specific model."
  );
}

async function checkAndSetAPIKey(selectedModel: (typeof models)[number]) {
  const provider = selectedModel.provider;
  const apiKeyPresent = checkAPIKey(provider);

  if (!apiKeyPresent) {
    await getAndSetAPIKey(provider);
  }

  console.log(chalk.green(`API key for ${provider} has been set.`));
}

function checkContextWindowOverflow(
  inputTokens: number,
  selectedModel: (typeof models)[number]
): { overflow: boolean; overflowTokens?: number; overflowPercentage?: number } {
  const availableTokens =
    selectedModel.contextWindow - selectedModel.outputLength;
  if (inputTokens > availableTokens) {
    const overflowTokens = inputTokens - availableTokens;
    const overflowPercentage = (overflowTokens / availableTokens) * 100;
    return { overflow: true, overflowTokens, overflowPercentage };
  }
  return { overflow: false };
}

async function main() {
  let inputs = process.argv.slice(2);

  if (inputs[0] === "revert") {
    revertLastChanges();
    return;
  }

  const printCodeAndExit = inputs.includes("-p");
  const includeImports = inputs.includes("-a");
  inputs = inputs.filter((input) => !input.startsWith("-") && !!input);

  const modelNickname = inputs.pop()!;
  let selectedModel = models.find((model) => model.nickName === modelNickname);

  if (!selectedModel) {
    if (modelNickname) inputs.push(modelNickname);
    selectedModel = models[0];
  }

  if (inputs.length === 0) {
    console.error("Problem: No files or folders to process");
    process.exit(1);
  }

  const processedFiles = await processFiles(inputs, includeImports);

  if (printCodeAndExit) {
    fs.writeFileSync("compiled-code.txt", processedFiles.code);
    console.log(
      "Combined line-tagged code saved to compiled-code.txt. Thank you for using Mandark!"
    );
    process.exit(0);
  }

  console.log("\n\nWelcome to Mandark!");

  listAvailableModels();

  console.log(
    `Selected model: ${selectedModel.nickName} (${selectedModel.name} from ${selectedModel.provider})\n`
  );

  await checkAndSetAPIKey(selectedModel);

  const estimatedTokens = countTokens(
    processedFiles.code + taskPrompt("x".repeat(100))
  );

  const overflowCheck = checkContextWindowOverflow(
    estimatedTokens,
    selectedModel
  );
  if (overflowCheck.overflow) {
    console.log(
      chalk.yellow(
        `Warning: Input exceeds model's context window by ${
          overflowCheck.overflowTokens
        } tokens (${overflowCheck.overflowPercentage?.toFixed(2)}%).`
      )
    );
    const continueAnyway = await confirm({
      message:
        "Do you want to continue anyway? (This may result in incomplete processing)",
      default: false,
    });
    if (!continueAnyway) {
      console.log("Please reduce the input size and try again.");
      process.exit(0);
    }
  }

  const estimatedCosts =
    (estimatedTokens / 1000000) * selectedModel.inputCPM +
    selectedModel.outputCPM * (selectedModel.outputLength / 10000000);

  console.log(
    `Loaded ${
      processedFiles.count
    } files (${estimatedTokens} tokens). Estimated max cost: $${estimatedCosts.toFixed(
      4
    )}`
  );

  const task = await input({
    message:
      "What do you need me to do? (Type 'ask' followed by your question to ask a question instead): ",
    validate: (input: string) => input.trim() !== "" || "Task cannot be empty",
  });

  if (task.toLowerCase().startsWith("ask ")) {
    const question = task.slice(4).trim();
    const answerStream = askAI(
      processedFiles.code,
      question,
      selectedModel.name,
      selectedModel.provider
    );
    for await (const chunk of answerStream) {
      process.stdout.write(chunk);
    }
    console.log("\n");
  } else {
    let editPacketStream;
    if (selectedModel.provider === "anthropic") {
      editPacketStream = await getAIEditsFromClaude(
        processedFiles.code,
        task,
        selectedModel.name as
          | "claude-3-5-sonnet-20240620"
          | "claude-3-haiku-20240307"
      );
    } else if (selectedModel.provider === "openai") {
      editPacketStream = await getAIEditsFromGPT(
        processedFiles.code,
        task,
        selectedModel.name
      );
    } else if (selectedModel.provider === "fireworks") {
      editPacketStream = await getAIEditsFromFireworks(
        processedFiles.code,
        task,
        selectedModel.name
      );
    } else {
      console.error(`Unsupported provider: ${selectedModel.provider}`);
      process.exit(1);
    }

    const editProcessor = new EditProcessor();
    const verifiedEditStream = await verifyEditStream(
      editPacketStream,
      checkAPIKey(preferredVerifierModel.provider)
        ? preferredVerifierModel.provider
        : selectedModel.provider
    );
    await editProcessor.processEditStream(verifiedEditStream);
  }

  console.log(
    chalk.cyan(
      "Leave a star if you like it! https://github.com/hrishioa/mandark"
    )
  );
}

main().catch(console.error);
