import express, { Request, Response, Router, RequestHandler, ErrorRequestHandler } from 'express';
import cors from 'cors';
import { analyzeQuestions, setEnvironmentVariables, getVoiceflowApiUrl } from './index.js';
import { z } from 'zod';
import { db } from './db.js';
import crypto from 'crypto';

const app = express();
const router = Router();

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  next();
});

const querySchema = z.object({
  range: z.enum(['today', 'yesterday', 'last7', 'last30', 'alltime']).default('last7'),
  top: z.string().transform(val => val.toString()).default('10')
});

const bodySchema = z.object({
  VF_API_KEY: z.string().optional(),
  PROJECT_ID: z.string().optional()
});

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

// ✅ Ensure analyzeQuestions() only runs when an API request is made
const analyzeHandler: RequestHandler<{}, any, RequestBody, QueryParams> = async (req, res, next) => {
  try {
    const query = querySchema.parse(req.query);
    const body = bodySchema.parse(req.body);
    const reportId = crypto.randomUUID();

    console.log(`🚀 API Request: Starting analysis - reportId: ${reportId}, range: ${query.range}, top: ${query.top}`);

    setEnvironmentVariables({
      TIME_RANGE: query.range,
      TOP_QUESTIONS: query.top,
      IS_SERVER: true,
      ...(body.VF_API_KEY && { VF_API_KEY: body.VF_API_KEY }),
      ...(body.PROJECT_ID && { PROJECT_ID: body.PROJECT_ID })
    });

    // Create pending report
    const report = await db.createReport(reportId, query.range, parseInt(query.top));

    // Start a test request to validate credentials before proceeding
    const testRequest = await fetch(
      `${getVoiceflowApiUrl()}/v2/transcripts/${body.PROJECT_ID || process.env.PROJECT_ID}?range=Today`,
      {
        headers: {
          Authorization: body.VF_API_KEY || process.env.VF_API_KEY || '',
          'accept': 'application/json'
        }
      }
    );

    if (!testRequest.ok) {
      throw new Error(`Failed to validate credentials: ${testRequest.statusText}`);
    }

    analyzeQuestions()
      .then(result => {
        console.log(`✅ Analysis completed - reportId: ${reportId}`);
        db.updateReport(reportId, { status: 'completed', result });
      })
      .catch(error => {
        console.error(`❌ Analysis failed - reportId: ${reportId}:`, error.message);
        db.updateReport(reportId, {
          status: 'failed',
          error: error.message
        });
      });

    res.json({
      success: true,
      data: {
        reportId,
        status: report.status,
        message: 'Analysis started. Use the reportId to check status and get results.'
      }
    });
  } catch (error) {
    next(error);
  }
};

// ✅ Get report status and results
const getReportHandler: RequestHandler<ReportParams> = async (req, res, next) => {
  try {
    const report = await db.getReport(req.params.reportId);

    if (!report) {
      console.log(`❌ Report not found - reportId: ${req.params.reportId}`);
      res.status(404).json({ success: false, error: 'Report not found' });
      return;
    }

    console.log(`✅ Report retrieved - reportId: ${req.params.reportId}, status: ${report.status}`);

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
    });
  } catch (error) {
    next(error);
  }
};

// ✅ Register routes
router.post('/api/analyze', analyzeHandler);
router.get('/api/reports/:reportId', getReportHandler);
router.get('/health', (_, res) => res.json({ status: 'ok' }));

app.use(router);

// ✅ Start the server
export async function startServer(port: number = 3000): Promise<void> {
  return new Promise((resolve) => {
    app.listen(port, () => {
      console.log(`✅ Server running at http://localhost:${port}`);
      resolve();
    });
  });
}
