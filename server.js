const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const rafflesRoute = require('./routes/raffles');
require('./scheduler');

const app = express();
app.use(bodyParser.json());

// Use CORS middleware. For troubleshooting, you can allow all origins first:
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    const allowedOrigins = [
      'https://raffles.kaspercoin.net',
      'https://kaspa-raffles-frontend-569b7d5f25f3.herokuapp.com'
    ];
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.error('CORS rejected origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  }
}));

// (Optional) Force CORS headers on all responses.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://raffles.kaspercoin.net');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  next();
});

// Handle preflight OPTIONS requests.
app.options('*', cors());

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

// Health-check endpoint.
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Global error handler that ensures CORS headers are set on errors.
app.use((err, req, res, next) => {
  console.error(err);
  res.setHeader('Access-Control-Allow-Origin', 'https://raffles.kaspercoin.net');
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
