const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const rafflesRoute = require('./routes/raffles');
require('./scheduler');

const app = express();
app.use(bodyParser.json());

// Standard CORS middleware (using a dynamic origin function)
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

// For a workaround, explicitly set the header on all GET requests:
app.use((req, res, next) => {
  if (req.method === 'GET') {
    // Only allow the specific origin you want (or use "*" to allow all)
    res.header('Access-Control-Allow-Origin', 'https://raffles.kaspercoin.net');
  }
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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
