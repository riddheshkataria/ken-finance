require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { categorizeTransactions, isConfigured } = require('./src/categorize');

const app = express();
const PORT = process.env.PORT || 5000;

/** Upper bound on one categorisation batch. */
const MAX_BATCH_SIZE = 50;

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Ken Finance backend API is running', timestamp: new Date().toISOString() });
});

/**
 * Categorisation, last tier only.
 *
 * The client must have exhausted merchant memory and the shipped dictionary
 * before calling this — those are free and cover most traffic. Batch the
 * transactions into one request rather than calling per transaction.
 *
 * Body: { items: [{ id, merchant, amountMinor, transactionType, note }] }
 */
app.post('/api/categorize', async (req, res) => {
  const items = req.body?.items;

  if (!Array.isArray(items)) {
    return res.status(400).json({ error: 'Expected { items: [...] }' });
  }

  // A cap keeps one request from becoming unboundedly expensive; the client
  // pages through anything larger.
  if (items.length > MAX_BATCH_SIZE) {
    return res
      .status(400)
      .json({ error: `At most ${MAX_BATCH_SIZE} items per request` });
  }

  if (!isConfigured()) {
    // Not an error the user should see — the app falls back to asking them.
    return res
      .status(503)
      .json({ error: 'Categorisation is not configured', results: [] });
  }

  const results = await categorizeTransactions(items);
  res.json({ results });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to Ken Finance API',
    categorization: isConfigured() ? 'enabled' : 'not configured',
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Ken Finance Backend server running at http://localhost:${PORT}`);
  if (!isConfigured()) {
    console.log(
      '   Categorisation disabled: set GEMINI_API_KEY to enable the LLM tier.',
    );
  }
});

