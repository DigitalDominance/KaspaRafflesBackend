const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const rafflesRoute = require('./routes/raffles');
// Require scheduler for its side effects (ensure scheduler.js does not export a middleware function)
require('./scheduler');

const app = express();
app.use(bodyParser.json());

// CORS middleware: dynamically allow specific origins.
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (e.g. Postman, curl)
    if (!origin) return callback(null, true);
    const allowedOrigins = [
      'https://raffles.kaspercoin.net',
      'https://kaspa-raffles-frontenddev-e229a2396b6e.herokuapp.com'
    ];
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.error('CORS rejected origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  }
}));

// Optional: force CORS headers on every request.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://kaspa-raffles-frontenddev-e229a2396b6e.herokuapp.com');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  next();
});

// Handle preflight OPTIONS requests.
app.options('*', (req, res) => {
  res.sendStatus(200);
});

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

app.use('/api/raffles', rafflesRoute);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Global error handler (ensures CORS headers on error responses)
app.use((err, req, res, next) => {
  console.error(err);
  res.setHeader('Access-Control-Allow-Origin', 'https://kaspa-raffles-frontenddev-e229a2396b6e.herokuapp.com');
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
