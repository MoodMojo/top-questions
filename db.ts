import { open } from 'sqlite'
import sqlite3 from 'sqlite3'
import { ClusteringResult } from './types.js'

export interface Report {
  id: string;
  status: 'pending' | 'completed' | 'failed';
  timeRange: string;
  topCount: number;
  result?: ClusteringResult;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface DBReport {
  id: string;
  status: string;
  time_range: string;
  top_count: number;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

class DatabaseService {
  private db: Awaited<ReturnType<typeof open>> | null = null;

  async init() {
    if (!this.db) {
      this.db = await open({
        filename: 'reports.db',
        driver: sqlite3.Database
      })

      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS reports (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          time_range TEXT NOT NULL,
          top_count INTEGER NOT NULL,
          result TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `)
    }
  }

  private async getDb() {
    if (!this.db) {
      await this.init()
    }
    return this.db!
  }

  async createReport(id: string, timeRange: string, topCount: number): Promise<Report> {
    const now = new Date().toISOString()
    const report: Report = {
      id,
      status: 'pending',
      timeRange,
      topCount,
      createdAt: now,
      updatedAt: now
    }

    const db = await this.getDb()
    await db.run(
      `INSERT INTO reports (id, status, time_range, top_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, report.status, timeRange, topCount, now, now]
    )

    return report
  }

  async updateReport(id: string, update: Partial<Report>): Promise<void> {
    const sets: string[] = []
    const values: any[] = []

    if (update.status) {
      sets.push('status = ?')
      values.push(update.status)
    }
    if (update.result) {
      sets.push('result = ?')
      values.push(JSON.stringify(update.result))
    }
    if (update.error) {
      sets.push('error = ?')
      values.push(update.error)
    }

    sets.push('updated_at = ?')
    values.push(new Date().toISOString())
    values.push(id)

    const db = await this.getDb()
    await db.run(
      `UPDATE reports SET ${sets.join(', ')} WHERE id = ?`,
      values
    )
  }

  async getReport(id: string): Promise<Report | null> {
    const db = await this.getDb()
    const row = await db.get('SELECT * FROM reports WHERE id = ?', id) as DBReport | undefined

    if (!row) return null

    return {
      id: row.id,
      status: row.status as Report['status'],
      timeRange: row.time_range,
      topCount: row.top_count,
      result: row.result ? JSON.parse(row.result) : undefined,
      error: row.error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  async cleanup(maxAge: number = 24 * 60 * 60 * 1000): Promise<void> {
    const cutoff = new Date(Date.now() - maxAge).toISOString()
    const db = await this.getDb()
    await db.run('DELETE FROM reports WHERE created_at < ?', cutoff)
  }

  async close() {
    if (this.db) {
      await this.db.close()
      this.db = null
    }
  }
}

export const db = new DatabaseService()

// Initialize database on startup
db.init().catch(console.error)

// Ensure the database is closed when the process exits
process.on('exit', () => {
  db.close().catch(console.error)
})
