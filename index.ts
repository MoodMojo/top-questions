import natural from 'natural';
import dotenv from 'dotenv';
import { z } from 'zod';
import OpenAI from 'openai';
import ora from 'ora';
import chalk from 'chalk';
import { QuestionFrequency, ClusteringResult } from './types.js';

dotenv.config({ override: true });

const tokenizer = new natural.SentenceTokenizer([]);

type TimeRange = 'today' | 'yesterday' | 'last7' | 'last30' | 'alltime';

const RANGE_MAPPING: Record<TimeRange, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7: 'Last%207%20Days',
  last30: 'Last%2030%20days',
  alltime: 'All%20time'
};

const GPT_PRICING = {
  prompt_per_1k: 0.03,
  completion_per_1k: 0.06
};

let envVars = {
  TIME_RANGE: 'last7',
  TOP_QUESTIONS: '10',
  IS_SERVER: false
};

function getConfig(overrides?: Partial<typeof envVars>) {
  if (overrides) {
    envVars = { ...envVars, ...overrides };
  }

  const envSchema = z.object({
    PROJECT_ID: z.string(),
    VF_API_KEY: z.string(),
    OPENAI_API_KEY: z.string(),
    TOP_QUESTIONS: z.string().transform(val => parseInt(val, 10)).default("10"),
    TIME_RANGE: z.enum(['today', 'yesterday', 'last7', 'last30', 'alltime']).default('today'),
    IS_SERVER: z.boolean().default(false),
    VF_CLOUD: z.string().optional()
  });

  return envSchema.parse({
    PROJECT_ID: process.env.PROJECT_ID,
    VF_API_KEY: process.env.VF_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    TOP_QUESTIONS: envVars.TOP_QUESTIONS,
    TIME_RANGE: envVars.TIME_RANGE,
    IS_SERVER: envVars.IS_SERVER,
    VF_CLOUD: process.env.VF_CLOUD
  });
}

let env = getConfig();

export function setEnvironmentVariables(vars: Partial<typeof envVars>) {
  env = getConfig(vars);
}

export function getVoiceflowApiUrl(): string {
  return env.VF_CLOUD
    ? `https://api.${env.VF_CLOUD}.voiceflow.com`
    : 'https://api.voiceflow.com';
}

// ✅ Ensure analyzeQuestions() is ONLY called when triggered by API
export async function analyzeQuestions(): Promise<ClusteringResult> {
  console.log("✅ analyzeQuestions() has been called.");

  const summaries = await fetchTranscriptSummaries();
  const allDialogs = [];

  for (const summary of summaries) {
    try {
      const dialog = await fetchTranscriptDialog(summary._id);
      allDialogs.push(dialog);
      await delay(100);
    } catch (error) {
      console.error(`❌ Error fetching dialog for ${summary._id}:`, error);
    }
  }

  const dailyQuestions = groupQuestionsByDate(allDialogs, env.TIME_RANGE);
  const dailyResults = [];

  for (const { questions } of dailyQuestions) {
    const result = await processDailyBatch(questions);
    if (result.questions.length > 0) {
      dailyResults.push(result);
    }
    await delay(500);
  }

  return combineResults(dailyResults);
}
