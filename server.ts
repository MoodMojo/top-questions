import express, { Request, Response, Router, RequestHandler, ErrorRequestHandler } from 'express'
import cors from 'cors'
import { analyzeQuestions, setEnvironmentVariables, getVoiceflowApiUrl } from './index.js'
import { z } from 'zod'
import { db } from './db.js'
import crypto from 'crypto'

const app = express()
const router = Router()

app.use(cors())
app.use(express.json())

app.use((req, res, next) => {
  req.id = crypto.randomUUID()
  next()
})

const querySchema = z.object({
  range: z.enum(['today', 'yesterday', 'last7', 'last30', 'alltime', 'monthToDate']).default('last7'),
  top: z.string().transform(val => val.toString()).default('10')
})

const bodySchema = z.object({
  VF_API_KEY: z.string().optional(),
  PROJECT_ID: z.string().optional()
})

interface ReportParams {
  reportId: string;
}

interface QueryParams {
  range?: string;
  top?: string;
}

interface RequestBody {
  VF_API_KEY?: string;
  PROJECT_ID?: string;
}

declare global {
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

// Start analysis and return report ID
const analyzeHandler: RequestHandler<{}, any, RequestBody, QueryParams> = async (req, res, next) => {
  try {
    const query = querySchema.parse(req.query)
    const body = bodySchema.parse(req.body)
    const reportId = crypto.randomUUID()

    console.log(`[${new Date().toISOString()}] Starting analysis - reportId: ${reportId}, range: ${query.range}, top: ${query.top}`)

    setEnvironmentVariables({
      TIME_RANGE: query.range,
      TOP_QUESTIONS: query.top,
      IS_SERVER: true,
      ...(body.VF_API_KEY && { VF_API_KEY: body.VF_API_KEY }),
      ...(body.PROJECT_ID && { PROJECT_ID: body.PROJECT_ID })
    })

    // Create pending report
    const report = await db.createReport(reportId, query.range, parseInt(query.top))

    // Start a test request to validate credentials before proceeding
    const testRequest = await fetch(
      `${getVoiceflowApiUrl()}/v2/transcripts/${body.PROJECT_ID || process.env.PROJECT_ID}?range=Today`,
      {
        headers: {
          'Authorization': body.VF_API_KEY || process.env.VF_API_KEY || '',
          'accept': 'application/json'
        }
      }
    )

    if (!testRequest.ok) {
      if (testRequest.status === 401) {
        throw new Error('Invalid Voiceflow API key')
      } else if (testRequest.status === 404) {
        throw new Error('Invalid project ID')
      } else {
        throw new Error(`Failed to validate credentials: ${testRequest.statusText}`)
      }
    }

    // Start analysis in background only after validation succeeds
    analyzeQuestions()
      .then(result => {
        console.log(`[${new Date().toISOString()}] Analysis completed - reportId: ${reportId}`)
        db.updateReport(reportId, { status: 'completed', result })
      })
      .catch(error => {
        console.error(`[${new Date().toISOString()}] Analysis failed - reportId: ${reportId}:`, error instanceof Error ? error.message : 'Unknown error occurred')
        db.updateReport(reportId, {
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error occurred'
        })
      })

    // Return report ID immediately
    res.json({
      success: true,
      data: {
        reportId,
        status: report.status,
        message: 'Analysis started. Use the reportId to check status and get results.'
      }
    })
  } catch (error) {
    next(error)
  }
}

// Get report status and results
const getReportHandler: RequestHandler<ReportParams> = async (req, res, next) => {
  try {
    const report = await db.getReport(req.params.reportId)

    if (!report) {
      console.log(`[${new Date().toISOString()}] Report not found - reportId: ${req.params.reportId}`)
      res.status(404).json({
        success: false,
        error: 'Report not found'
      })
      return
    }

    console.log(`[${new Date().toISOString()}] Report retrieved - reportId: ${req.params.reportId}, status: ${report.status}`)

    res.json({
      success: true,
      data: {
        status: report.status,
        timeRange: report.timeRange,
        createdAt: report.createdAt,
        updatedAt: report.updatedAt,
        ...(report.status === 'completed' && { result: report.result }),
        ...(report.status === 'failed' && { error: report.error })
      }
    })
  } catch (error) {
    next(error)
  }
}

// Health check endpoint
const healthHandler: RequestHandler = (_, res) => {
  res.json({ status: 'ok' })
}

// Error handling middleware
const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Error processing request:`, err instanceof Error ? err.message : 'Unknown error occurred')

  // Handle specific API errors
  if (err instanceof Error) {
    if (err.message.includes('Invalid Voiceflow API key')) {
      res.status(401).json({
        success: false,
        error: 'Invalid Voiceflow API key'
      })
      return
    }
    if (err.message.includes('Invalid project ID')) {
      res.status(404).json({
        success: false,
        error: 'Invalid project ID'
      })
      return
    }
  }

  res.status(err.status || 500).json({
    success: false,
    error: err instanceof Error ? err.message : 'Unknown error occurred'
  })
}

// Register routes
router.post('/api/analyze', analyzeHandler)
router.get('/api/reports/:reportId', getReportHandler)
router.get('/health', healthHandler)

// Use router and error handler
app.use(router)
app.use(errorHandler)

// Cleanup old reports periodically (24 hours)
/* setInterval(() => {
  db.cleanup().catch(error => {
    console.error(`[${new Date().toISOString()}] Error during cleanup:`, error instanceof Error ? error.message : 'Unknown error occurred')
  })
}, 60 * 60 * 1000) // Run every hour */

export async function startServer(port: number = 8000): Promise<void> {
  return new Promise((resolve) => {
    app.listen(port, () => {
      console.log(`\nServer running at http://localhost:${port}`)
      resolve()
    })
  })
}
