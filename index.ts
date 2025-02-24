import natural from 'natural'
import dotenv from 'dotenv'
import { z } from 'zod'
import OpenAI from 'openai'
import ora from 'ora'
import chalk from 'chalk'
import { QuestionFrequency, ClusteringResult } from './types.js'

dotenv.config({ override: true })

const tokenizer = new natural.SentenceTokenizer([])

type TimeRange = 'today' | 'yesterday' | 'last7' | 'last30' | 'alltime' | 'monthToDate';

const RANGE_MAPPING: Record<TimeRange, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7: 'Last%207%20Days',
  last30: 'Last%2030%20days',
  alltime: 'All%20time',
  monthToDate: 'Month%20to%20Date' // New addition
}

// GPT-4o pricing per 1k tokens
const GPT_PRICING = {
  prompt_per_1k: 0.03,
  completion_per_1k: 0.06
}

let envVars = {
  TIME_RANGE: 'last7',
  TOP_QUESTIONS: '10',
  IS_SERVER: false
}

function getConfig(overrides?: Partial<typeof envVars>) {
  if (overrides) {
    envVars = { ...envVars, ...overrides }
  }

  const envSchema = z.object({
    PROJECT_ID: z.string(),
    VF_API_KEY: z.string(),
    OPENAI_API_KEY: z.string(),
    TOP_QUESTIONS: z.string().transform(val => parseInt(val, 10)).default("10"),
    TIME_RANGE: z.enum(['today', 'yesterday', 'last7', 'last30', 'alltime', 'monthToDate']).default('today'),
    IS_SERVER: z.boolean().default(false),
    VF_CLOUD: z.string().optional()
  })

  return envSchema.parse({
    PROJECT_ID: process.env.PROJECT_ID,
    VF_API_KEY: process.env.VF_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    TOP_QUESTIONS: envVars.TOP_QUESTIONS,
    TIME_RANGE: envVars.TIME_RANGE,
    IS_SERVER: envVars.IS_SERVER,
    VF_CLOUD: process.env.VF_CLOUD
  })
}

let env = getConfig()

export function setEnvironmentVariables(vars: Partial<typeof envVars>) {
  env = getConfig(vars)
}

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY
})

interface TranscriptSummary {
  _id: string;
  projectID: string;
  sessionID: string;
  createdAt: string;
}

interface TranscriptDialog {
  turnID: string;
  type: string;
  startTime?: string;
  payload: {
    type?: string;
    payload?: {
      message?: string;
      slate?: {
        content: Array<{children: Array<{text: string}>}>;
      };
      query?: string;
      intent?: { name: string };
    };
  };
}

export function getVoiceflowApiUrl(): string {
  return env.VF_CLOUD
    ? `https://api.${env.VF_CLOUD}.voiceflow.com`
    : 'https://api.voiceflow.com'
}

// Add API key validation
async function validateVoiceflowCredentials(): Promise<void> {
  const response = await fetch(
    `${getVoiceflowApiUrl()}/v2/transcripts/${env.PROJECT_ID}?range=Today`,
    {
      headers: {
        'Authorization': env.VF_API_KEY,
        'accept': 'application/json'
      }
    }
  )

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Invalid Voiceflow API key')
    } else if (response.status === 404) {
      throw new Error('Invalid project ID')
    } else {
      throw new Error(`Failed to validate credentials: ${response.statusText}`)
    }
  }
}

async function fetchTranscriptSummaries(): Promise<TranscriptSummary[]> {
  // Validate credentials before making any requests
  await validateVoiceflowCredentials()

  const range = RANGE_MAPPING[env.TIME_RANGE]
  const response = await fetch(
    `${getVoiceflowApiUrl()}/v2/transcripts/${env.PROJECT_ID}?range=${range}`,
    {
      headers: {
        'Authorization': env.VF_API_KEY,
        'accept': 'application/json'
      }
    }
  )

  if (!response.ok) {
    throw new Error(`Failed to fetch transcripts: ${response.statusText}`)
  }

  const data = await response.json()
  return data
}

// Add this helper function for delay
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchTranscriptDialog(transcriptId: string): Promise<TranscriptDialog[]> {
  const response = await fetch(
    `${getVoiceflowApiUrl()}/v2/transcripts/${env.PROJECT_ID}/${transcriptId}`,
    {
      headers: {
        'Authorization': env.VF_API_KEY,
        'accept': 'application/json'
      }
    }
  )

  if (!response.ok) {
    throw new Error(`Failed to fetch transcript dialog: ${response.statusText}`)
  }

  const data = await response.json()
  return data
}

function extractTextFromDialog(dialog: TranscriptDialog[]): string {
  return dialog
    .filter(turn => turn.type === 'request' && turn.payload?.payload?.query)
    .map(turn => turn.payload?.payload?.query ?? '')
    .join(' ')
}

function extractQuestions(transcript: string): string[] {
  const sentences = tokenizer.tokenize(transcript) || []
  return sentences
  })
}

function getTimeRangeConstraints(range: TimeRange): { startDate: Date, endDate: Date } {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  switch (range) {
    case 'today':
      return {
        startDate: today,
        endDate: now
      }
    case 'yesterday': {
      const yesterday = new Date(today)
      yesterday.setDate(yesterday.getDate() - 1)
      return {
        startDate: yesterday,
        endDate: new Date(today)
      }
    }
    case 'last7': {
      const sevenDaysAgo = new Date(today)
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
      return {
        startDate: sevenDaysAgo,
        endDate: now
      }
    }
    case 'last30': {
      const thirtyDaysAgo = new Date(today)
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
      return {
        startDate: thirtyDaysAgo,
        endDate: now
      }
    }
    case 'monthToDate': { // New case
      const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1)
      return { startDate: startOfMonth, endDate: now }
    }
    case 'alltime':
      return {
        startDate: new Date(0), // Beginning of time
        endDate: now
      }
  }
}

function isMessageInTimeRange(startTime: string, range: TimeRange): boolean {
  const messageDate = new Date(startTime)
  const { startDate, endDate } = getTimeRangeConstraints(range)
  return messageDate >= startDate && messageDate <= endDate
}

function filterDialogsByTimeRange(dialog: TranscriptDialog[], range: TimeRange): TranscriptDialog[] {
  return dialog.filter(message =>
    message.startTime && isMessageInTimeRange(message.startTime, range)
  )
}

function groupQuestionsByDate(dialogs: TranscriptDialog[][], timeRange: TimeRange): DailyQuestions[] {
  const dailyQuestionsMap = new Map<string, string[]>()

  dialogs.forEach(dialog => {
    // Filter messages by time range first
    const filteredDialog = filterDialogsByTimeRange(dialog, timeRange)
    if (filteredDialog.length === 0) return

    const firstMessage = filteredDialog[0]
    if (!firstMessage?.startTime) return

    try {
      // Parse the ISO date string and extract just the date part
      const date = firstMessage.startTime.split('T')[0]
      const questions = extractQuestions(extractTextFromDialog(filteredDialog))
      if (questions.length === 0) return

      const existing = dailyQuestionsMap.get(date) || []
      dailyQuestionsMap.set(date, [...existing, ...questions])
    } catch (error) {
      console.error(chalk.yellow(`Warning: Failed to parse date from startTime: ${firstMessage.startTime}`))
      return
    }
  })

  return Array.from(dailyQuestionsMap.entries())
    .map(([date, questions]) => ({ date, questions }))
    .sort((a, b) => b.date.localeCompare(a.date)) // Sort by date descending
}

async function processDailyBatch(questions: string[]): Promise<ClusteringResult> {
  if (questions.length === 0) {
    return {
      questions: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, estimated_cost_usd: 0 }
    }
  }

  const prompt = `Analyze and cluster these user questions from a customer support chat. Return only the top ${env.TOP_QUESTIONS} most frequent questions. For each unique question:
1. Keep the original wording if it appears multiple times exactly
2. For similar questions with different wording, group them and use the most specific, clear wording
3. Count exact matches and similar intent questions together
4. Maintain specific details, product names, and technical terms
5. Do not over-generalize or combine questions with different intents

Questions to analyze:
${questions.join('\n')}

Respond in this JSON format with exactly ${env.TOP_QUESTIONS} questions:
{
  "questions": [
    {"question": "exact question or most specific variant", "count": number_of_occurrences},
    ...
  ]
}
`

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: 'You are a precise question clustering assistant. Be consistent in how you group questions. Prefer keeping specific details over generalizing. Never combine questions that ask about different features or topics. Return exactly the requested number of top questions.'
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    response_format: { type: "json_object" },
    temperature: 0.1,
  })

  const content = response.choices[0].message.content
  if (!content) return { questions: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, estimated_cost_usd: 0 } }

  const clusters = JSON.parse(content).questions

  // Calculate costs
  const usage = response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  const estimated_cost_usd = (
    (usage.prompt_tokens / 1000) * GPT_PRICING.prompt_per_1k +
    (usage.completion_tokens / 1000) * GPT_PRICING.completion_per_1k
  )

  // Sort by count descending
  const sortedQuestions = clusters
    .sort((a: QuestionFrequency, b: QuestionFrequency) => {
      if (a.count !== b.count) {
        return b.count - a.count
      }
      return a.question.localeCompare(b.question)
    })
    .slice(0, parseInt(env.TOP_QUESTIONS.toString()))

  return {
    questions: sortedQuestions,
    usage: {
      ...usage,
      estimated_cost_usd
    }
  }
}

function combineResults(dailyResults: ClusteringResult[]): ClusteringResult {
  // Combine all questions into a frequency map
  const frequencyMap = new Map<string, number>()

  dailyResults.forEach(result => {
    result.questions.forEach(q => {
      const normalized = q.question.toLowerCase().trim()
      frequencyMap.set(normalized, (frequencyMap.get(normalized) || 0) + q.count)
    })
  })

  // Convert to array and sort
  const combinedQuestions = Array.from(frequencyMap.entries())
    .map(([question, count]) => ({ question, count }))
    .sort((a, b) => {
      if (a.count !== b.count) {
        return b.count - a.count
      }
      return a.question.localeCompare(b.question)
    })
    .slice(0, parseInt(env.TOP_QUESTIONS.toString()))

  // Sum up token usage
  const usage = dailyResults.reduce((acc, curr) => ({
    prompt_tokens: acc.prompt_tokens + curr.usage.prompt_tokens,
    completion_tokens: acc.completion_tokens + curr.usage.completion_tokens,
    total_tokens: acc.total_tokens + curr.usage.total_tokens,
    estimated_cost_usd: acc.estimated_cost_usd + curr.usage.estimated_cost_usd
  }), {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    estimated_cost_usd: 0
  })

  return {
    questions: combinedQuestions,
    usage
  }
}

export async function analyzeQuestions(): Promise<ClusteringResult> {
  if (!env.IS_SERVER) {
    console.log(chalk.blue(`\n🔍 Analyzing questions from ${env.TIME_RANGE} transcripts...\n`))
  }

  const summaries = await withProgress(
    'Fetching transcripts...',
    () => fetchTranscriptSummaries()
  )

  if (!env.IS_SERVER) {
    console.log(chalk.gray(`Found ${summaries.length} transcripts to process\n`))
  }

  // Fetch all dialogs
  const allDialogs: TranscriptDialog[][] = []
  if (!env.IS_SERVER) {
    const progressBar = ora('Fetching transcript dialogs...').start()
    for (let i = 0; i < summaries.length; i++) {
      const summary = summaries[i]
      progressBar.text = `Fetching dialogs... [${i + 1}/${summaries.length}]`
      try {
        const dialog = await fetchTranscriptDialog(summary._id)
        allDialogs.push(dialog)
        await delay(100)
      } catch (error) {
        console.error(chalk.red(`\nError fetching dialog for ${summary._id}:`, error))
      }
    }
    progressBar.succeed('Fetched all dialogs')
  } else {
    // Server mode - fetch without progress indicators
    for (const summary of summaries) {
      try {
        const dialog = await fetchTranscriptDialog(summary._id)
        allDialogs.push(dialog)
        await delay(100)
      } catch (error) {
        // Silent error in server mode
      }
    }
  }

  // For 'today', process all dialogs at once without batching
  if (env.TIME_RANGE === 'today') {
    const allQuestions = allDialogs.flatMap(dialog =>
      filterDialogsByTimeRange(dialog, env.TIME_RANGE)
        .filter(turn => turn.type === 'request' && turn.payload?.payload?.query)
        .map(turn => turn.payload?.payload?.query ?? '')
    ).filter(Boolean)

    // Process in a single batch, works the same in both server and CLI mode
    return await withProgress(
      'Processing questions...',
      () => processDailyBatch(allQuestions)
    )
  }

  // For other time ranges, continue with daily batching
  const dailyQuestions = groupQuestionsByDate(allDialogs, env.TIME_RANGE)
  if (!env.IS_SERVER) {
    console.log(chalk.gray(`\nProcessing questions from ${dailyQuestions.length} days`))
  }

  const dailyResults: ClusteringResult[] = []

  if (!env.IS_SERVER) {
    const batchProgress = ora('Processing daily batches...').start()
    for (let i = 0; i < dailyQuestions.length; i++) {
      const { date, questions } = dailyQuestions[i]
      batchProgress.text = `Processing ${date} (${i + 1}/${dailyQuestions.length})`
      console.log(chalk.gray(`\n📦 Processing batch for ${date} with ${questions.length} questions (${i + 1}/${dailyQuestions.length})`))
      const result = await processDailyBatch(questions)
      if (result.questions.length > 0) {
        dailyResults.push(result)
        console.log(chalk.gray(`✓ Found ${result.questions.length} clustered questions for ${date}`))
      } else {
        console.log(chalk.gray(`- No questions found for ${date}`))
      }
      if (i < dailyQuestions.length - 1) await delay(500)
    }
    batchProgress.succeed('Processed all daily batches')
  } else {
    // Server mode - process without progress indicators
    for (const { questions } of dailyQuestions) {
      const result = await processDailyBatch(questions)
      if (result.questions.length > 0) {
        dailyResults.push(result)
      }
      await delay(500)
    }
  }

  const result = await withProgress(
    'Combining daily results...',
    () => Promise.resolve(combineResults(dailyResults))
  )

  return result
}

interface DailyQuestions {
  date: string;
  questions: string[];
}

// Add progress tracking helper
async function withProgress<T>(
  message: string,
  task: () => Promise<T>,
  options?: { successMessage?: string }
): Promise<T> {
  if (env.IS_SERVER) {
    return task()
  }

  const spinner = ora(message).start()
  try {
    const result = await task()
    spinner.succeed(options?.successMessage || message)
    return result
  } catch (error) {
    spinner.fail()
    throw error
  }
}
