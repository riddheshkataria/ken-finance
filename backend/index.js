require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Ken Finance backend API is running', timestamp: new Date().toISOString() });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to Ken Finance API' });
});

app.listen(PORT, () => {
  console.log(`🚀 Ken Finance Backend server running at http://localhost:${PORT}`);
});

