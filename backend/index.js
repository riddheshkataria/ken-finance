require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Ken Finance Backend API is running' });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

