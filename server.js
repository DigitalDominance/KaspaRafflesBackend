const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const rafflesRoute = require('./routes/raffles');

const app = express();
app.use(bodyParser.json());

// Connect to MongoDB (use your own connection string via process.env.MONGO_URI)
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost/kaspa-raffles', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});
mongoose.connection.on('connected', () => {
  console.log('Connected to MongoDB');
});
mongoose.connection.on('error', (err) => {
  console.error('MongoDB connection error:', err);
});

// API routes
app.use('/api/raffles', rafflesRoute);

// Health-check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
