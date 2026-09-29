import OpenAI from "openai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type Thesis = {
  ticker: string;
  company: string;
  strategy: string;
  prediction: string;
  confidence: number;
  assumptions: string[];
  invalidationConditions: string[];
  reviewAt: string;
  citations: string[];
};

type Usage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  requests: number;
};

type CompanySnapshot = {
  ticker: string;
  companyName: string;
  cik: string;
  fiscalYear?: number;
  revenue?: number;
  netIncome?: number;
  assets?: number;
  liabilities?: number;
  source: string;
  limitations: string[];
};

const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";
const thesisStorePath = path.join(process.cwd(), "data", "theses.jsonl");
const usage: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  requests: 0,
};

const secHeaders = {
  "User-Agent": process.env.SEC_USER_AGENT ?? "personal-investing-agent/0.1 educational paper research contact@example.com",
  Accept: "application/json",
};

const tools: OpenAI.Responses.Tool[] = [
  {
    type: "function",
    name: "get_company_snapshot",
    description: "Return a small research snapshot for a company ticker.",
    parameters: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "A stock ticker symbol." },
      },
      required: ["ticker"],
      additionalProperties: false,
    },
    strict: true,
  },
];

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function latestAnnualValue(facts: unknown, concept: string): { value?: number; fiscalYear?: number } {
  const units = (facts as Record<string, any>)?.["us-gaap"]?.[concept]?.units;
  const usdFacts = units?.USD as Array<Record<string, unknown>> | undefined;
  const annualFacts = usdFacts
    ?.filter((item) => item.form === "10-K" && typeof item.fy === "number" && typeof item.val === "number")
    .sort((a, b) => Number(b.fy) - Number(a.fy));

  const latest = annualFacts?.[0];
  return { value: asNumber(latest?.val), fiscalYear: asNumber(latest?.fy) };
}

async function fetchCompanySnapshot(ticker: string): Promise<CompanySnapshot> {
  const normalizedTicker = ticker.toUpperCase();
  const tickerResponse = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: secHeaders });
  if (!tickerResponse.ok) {
    throw new Error(`SEC ticker lookup failed with ${tickerResponse.status}`);
  }

  const tickerMap = await tickerResponse.json() as Record<string, { cik_str: number; ticker: string; title: string }>;
  const match = Object.values(tickerMap).find((entry) => entry.ticker.toUpperCase() === normalizedTicker);
  if (!match) {
    throw new Error(`No SEC ticker match found for ${normalizedTicker}`);
  }

  const cik = String(match.cik_str).padStart(10, "0");
  const factsResponse = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: secHeaders });
  if (!factsResponse.ok) {
    throw new Error(`SEC company facts lookup failed with ${factsResponse.status}`);
  }

  const facts = await factsResponse.json();
  const revenue = latestAnnualValue(facts, "Revenues");
  const netIncome = latestAnnualValue(facts, "NetIncomeLoss");
  const assets = latestAnnualValue(facts, "Assets");
  const liabilities = latestAnnualValue(facts, "Liabilities");

  return {
    ticker: normalizedTicker,
    companyName: match.title,
    cik,
    fiscalYear: revenue.fiscalYear ?? netIncome.fiscalYear ?? assets.fiscalYear,
    revenue: revenue.value,
    netIncome: netIncome.value,
    assets: assets.value,
    liabilities: liabilities.value,
    source: `SEC Company Facts API: https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
    limitations: [
      "SEC XBRL facts are historical filings, not live market prices or valuation data.",
      "Concept availability varies by filer and may need normalization before comparison.",
    ],
  };
}

async function getCompanySnapshot(ticker: string): Promise<CompanySnapshot> {
  if (process.env.USE_MOCK_DATA === "1") {
    return {
      ticker: ticker.toUpperCase(),
      companyName: `${ticker.toUpperCase()} mock company`,
      cik: "0000000000",
      fiscalYear: 2025,
      revenue: 120_000_000_000,
      netIncome: 24_000_000_000,
      assets: 180_000_000_000,
      liabilities: 76_000_000_000,
      source: "Mock fixture selected with USE_MOCK_DATA=1",
      limitations: ["Mock data is for local harness testing only."],
    };
  }

  return fetchCompanySnapshot(ticker);
}

async function executeTool(name: string, rawArguments: string): Promise<string> {
  if (name !== "get_company_snapshot") {
    throw new Error(`Unknown tool: ${name}`);
  }

  const { ticker } = JSON.parse(rawArguments) as { ticker: string };
  return JSON.stringify(await getCompanySnapshot(ticker));
}

function extractThesis(answer: string): Thesis | undefined {
  const match = answer.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) {
    return undefined;
  }

  const parsed = JSON.parse(match[1]) as Partial<Thesis>;
  if (
    typeof parsed.ticker !== "string" ||
    typeof parsed.company !== "string" ||
    typeof parsed.strategy !== "string" ||
    typeof parsed.prediction !== "string" ||
    typeof parsed.confidence !== "number" ||
    !Array.isArray(parsed.assumptions) ||
    !Array.isArray(parsed.invalidationConditions) ||
    typeof parsed.reviewAt !== "string" ||
    !Array.isArray(parsed.citations)
  ) {
    return undefined;
  }

  return parsed as Thesis;
}

async function persistThesis(thesis: Thesis): Promise<void> {
  await mkdir(path.dirname(thesisStorePath), { recursive: true });
  const record = {
    ...thesis,
    status: "pending_review",
    createdAt: new Date().toISOString(),
  };
  await writeFile(thesisStorePath, `${JSON.stringify(record)}\n`, { flag: "a" });
}

async function runAgent(question: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    const reviewAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return `[Mock mode]\n\nI would research the question: ${question}\n\nPaper thesis:\n\n\`\`\`json\n${JSON.stringify({
      ticker: "AAPL",
      company: "Apple Inc.",
      strategy: "Value-investing style quality screen",
      prediction: "Over the next seven days, the paper thesis is that the research question can be evaluated by comparing valuation concerns against durable cash generation, without treating the result as a buy or sell instruction.",
      confidence: 0.55,
      assumptions: ["SEC historical filings are sufficient for the first educational pass.", "No automatic trading or personalized allocation is being made."],
      invalidationConditions: ["Material filing restatement.", "New company-specific risk that changes the core business assumptions."],
      reviewAt,
      citations: ["Mock mode; configure OPENAI_API_KEY for live model output and USE_MOCK_DATA=1 for offline tool fixtures."],
    }, null, 2)}\n\`\`\``;
  }

  const client = new OpenAI();
  let response = await client.responses.create({
    model,
    input: question,
    tools,
    instructions: `
      You are an educational investing research assistant.
      Separate facts, assumptions, and interpretations.
      Do not give personalized buy or sell instructions.
      Use get_company_snapshot when a company is named.
      End with a paper-investment thesis as a fenced JSON block with this exact shape:
      {"ticker":"AAPL","company":"Apple Inc.","strategy":"...","prediction":"...","confidence":0.0,"assumptions":["..."],"invalidationConditions":["..."],"reviewAt":"YYYY-MM-DD","citations":["..."]}.
      The reviewAt date must be seven days from today.
    `,
    prompt_cache_key: "personal-investing-agent-v1",
  });

  for (let turn = 0; turn < 6; turn += 1) {
    usage.requests += 1;
    usage.inputTokens += response.usage?.input_tokens ?? 0;
    usage.cachedInputTokens += response.usage?.input_tokens_details?.cached_tokens ?? 0;
    usage.outputTokens += response.usage?.output_tokens ?? 0;

    const calls = response.output.filter(
      (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call",
    );

    if (calls.length === 0) {
      return response.output_text;
    }

    const outputs: OpenAI.Responses.ResponseInputItem[] = [];
    for (const call of calls) {
      outputs.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: await executeTool(call.name, call.arguments),
      });
    }

    response = await client.responses.create({
      model,
      previous_response_id: response.id,
      input: outputs,
      tools,
      prompt_cache_key: "personal-investing-agent-v1",
    });
  }

  throw new Error("Agent exceeded the maximum number of turns.");
}

async function main() {
  const question = process.argv.slice(2).join(" ") ||
    "Teach me how a value investor might investigate AAPL, then create a paper thesis.";

  const answer = await runAgent(question);
  const thesis = extractThesis(answer);
  if (thesis) {
    await persistThesis(thesis);
  }

  console.log(answer);
  if (thesis) {
    const thesisLog = await readFile(thesisStorePath, "utf8");
    const thesisCount = thesisLog.trim().split("\n").filter(Boolean).length;
    console.log(`\nSaved thesis ${thesisCount} to ${thesisStorePath}`);
  }
  console.log("\nUsage:", JSON.stringify(usage, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
