/**
 * `bun run eval`: run the cases against the configured real model, with a fake
 * Finance API serving fixtures. Not part of CI. Needs AGENT_MODEL plus
 * AI_GATEWAY_API_KEY or OPENROUTER_API_KEY (AI_PROVIDER picks one when both are set).
 */
import { createAgent } from "../src/core/agent";
import { SessionRecorder } from "../src/core/session";
import { getModel, type AiProvider } from "../src/llm/model";
import { createLogger } from "../src/log";
import { seedFinance } from "../test/fixtures/finance";
import { fakeFinance } from "../test/helpers";
import { cases, matches } from "./cases";

const USER = "424242";

function settings(): { provider: AiProvider; modelId: string; apiKey: string } | null {
  const gatewayKey = process.env.AI_GATEWAY_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (!gatewayKey && !openrouterKey) return null;
  const provider = (process.env.AI_PROVIDER as AiProvider | undefined) ?? (gatewayKey ? "gateway" : "openrouter");
  const apiKey = provider === "gateway" ? gatewayKey : openrouterKey;
  const modelId = process.env.AGENT_MODEL;
  if (!apiKey || !modelId) {
    console.error(`eval: set AGENT_MODEL and the key for AI_PROVIDER=${provider}`);
    process.exit(2);
  }
  return { provider, modelId, apiKey };
}

async function main() {
  const config = settings();
  if (!config) {
    console.log("eval skipped: set AI_GATEWAY_API_KEY or OPENROUTER_API_KEY (and AGENT_MODEL) to run it");
    return;
  }
  const only = process.argv[2] ? Number(process.argv[2]) : undefined;
  const model = getModel(config);
  // Quiet: the eval prints its own report. Warnings (failed turns) still show.
  const logger = createLogger({ level: "warn", secrets: [config.apiKey] });
  const agent = createAgent({
    model,
    maxSteps: Number(process.env.AGENT_MAX_STEPS ?? 6),
    turnTimeoutMs: 60_000,
    timezone: "Africa/Luanda",
    logger,
    now: () => new Date("2026-11-11T10:00:00Z"),
  });

  console.log(`eval: ${config.provider} ${config.modelId}, ${cases.length} cases\n`);
  let passed = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const [index, testCase] of cases.entries()) {
    if (only !== undefined && only !== index + 1) continue;
    const finance = fakeFinance();
    seedFinance(finance);
    finance.link(USER, { displayName: "Ana" });
    const user = finance.clients.forToken(`tok_${USER}`);
    const event = {
      channel: "telegram" as const,
      eventId: String(index + 1),
      sequence: index + 1,
      externalUserId: USER,
      chatId: USER,
      chatType: "private" as const,
      kind: "text" as const,
      text: testCase.message,
    };
    const label = `${String(index + 1).padStart(2)}. ${testCase.message}`;
    try {
      const result = await agent.runAgentTurn({
        text: testCase.message,
        session: new SessionRecorder(user, event, 30, logger),
        userContext: { displayName: "Ana", baseCurrency: "AOA" },
        finance: user,
      });
      inputTokens += result.usage.inputTokens;
      outputTokens += result.usage.outputTokens;
      const problems: string[] = [];
      for (const requirement of testCase.expect) {
        if (!result.toolCalls.some((call) => requirement.some((alt) => matches(alt, call)))) {
          problems.push(`expected ${requirement.map((alt) => alt.tool).join(" | ")}`);
        }
      }
      if (testCase.noTools && result.toolCalls.length) problems.push("expected no tool calls");
      if (testCase.reply && !testCase.reply.test(result.text)) problems.push(`reply should match ${testCase.reply}`);
      if (testCase.replyNot?.test(result.text)) problems.push(`reply must not match ${testCase.replyNot}`);
      const calls = result.toolCalls.map((call) => `${call.name}(${JSON.stringify(call.input)})`).join(", ") || "no tools";
      const ok = problems.length === 0;
      if (ok) passed += 1;
      console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
      console.log(`     ${calls} · ${result.steps} steps · ${result.usage.inputTokens}/${result.usage.outputTokens} tok`);
      if (!ok) console.log(`     ${problems.join("; ")}\n     reply: ${result.text.replace(/\n/g, " ⏎ ").slice(0, 300)}`);
    } catch (error) {
      console.log(`FAIL ${label}\n     error: ${(error as Error).name}: ${(error as Error).message}`);
    }
  }

  const total = only !== undefined ? 1 : cases.length;
  console.log(`\n${passed}/${total} passed · tokens in ${inputTokens} · out ${outputTokens} · total ${inputTokens + outputTokens}`);
  if (passed < total) process.exitCode = 1;
}

void main();
