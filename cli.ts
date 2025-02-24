#!/usr/bin/env node
import { Command } from 'commander'
import chalk from 'chalk'
import dotenv from 'dotenv'
import { analyzeQuestions, setEnvironmentVariables } from './index.js'
import { startServer } from './server.js'
import { db } from './db.js'

// Initialize commander
const program = new Command()
  .name('question-analyzer')
  .description('Analyze questions from Voiceflow transcripts')
  .option('-r, --range <range>', 'time range (today, yesterday, last7, last30, alltime, monthToDate)', 'last7')
  .option('-t, --top <number>', 'number of top questions to show', '10')
  .option('-s, --server', 'run in server mode')
  .option('-p, --port <number>', 'port number for server mode', '8000')
  .option('-c, --check <reportId>', 'check status of a specific report')
  .option('-a, --analyze', 'run the analysis directly')
  .parse(process.argv)

// Load env and override with CLI options
dotenv.config()
const options = program.opts()

async function displayReport(result: any) {
  console.log(chalk.blue('\n📊 Top Questions:'))
  result.questions.forEach((q: any, i: number) => {
    console.log(chalk.white(`\n${i + 1}. "${q.question}"`))
    console.log(chalk.gray(`   Asked ${q.count} times`))
  })

  // Display token usage and cost information
  console.log(chalk.blue('\n📈 Token Usage:'))
  console.log(chalk.gray(`   Prompt tokens: ${result.usage.prompt_tokens.toLocaleString()}`))
  console.log(chalk.gray(`   Completion tokens: ${result.usage.completion_tokens.toLocaleString()}`))
  console.log(chalk.gray(`   Total tokens: ${result.usage.total_tokens.toLocaleString()}`))
  console.log(chalk.blue('\n💰 Cost:'))
  console.log(chalk.gray(`   Estimated cost: $${result.usage.estimated_cost_usd.toFixed(4)}`))
  console.log('\n\n')
}

async function checkReport(reportId: string) {
  const report = await db.getReport(reportId)
  if (!report) {
    console.error(chalk.red('\n❌ Error: Report not found'))
    process.exit(1)
  }

  console.log(chalk.blue('\n📋 Report Status:'))
  console.log(chalk.gray(`   ID: ${report.id}`))
  console.log(chalk.gray(`   Status: ${report.status}`))
  console.log(chalk.gray(`   Time Range: ${report.timeRange}`))
  console.log(chalk.gray(`   Created: ${new Date(report.createdAt).toLocaleString()}`))
  console.log(chalk.gray(`   Updated: ${new Date(report.updatedAt).toLocaleString()}`))

  if (report.status === 'completed' && report.result) {
    await displayReport(report.result)
  } else if (report.status === 'failed' && report.error) {
    console.error(chalk.red('\n❌ Error:'), report.error)
  }
}

async function runAnalysis() {
  setEnvironmentVariables({
    TIME_RANGE: options.range,
    TOP_QUESTIONS: options.top.toString()
  })

  const result = await analyzeQuestions()
  await displayReport(result)
  process.exit(0)
}

async function main() {
  try {
    if (options.check) {
      await checkReport(options.check)
    } else if (options.analyze) {
      await runAnalysis()
    } else {
      console.log(chalk.blue('\n🚀 Starting server mode...'))
      await startServer(parseInt(options.port))
      console.log(chalk.gray('\nAvailable endpoints:'))
      console.log(chalk.gray('  GET /health - Health check'))
      console.log(chalk.gray('  POST /api/analyze - Start analysis'))
      console.log(chalk.gray('  GET /api/reports/:reportId - Get report status and results'))
      console.log(chalk.gray('\nExample:'))
      console.log(chalk.gray(`  curl -X POST "http://localhost:${options.port}/api/analyze?range=last7&top=5"`))
    }
  } catch (error) {
    console.error(chalk.red('\n❌ Error:'), error)
    process.exit(1)
  }
}

main()
