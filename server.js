const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const rafflesRoute = require('./routes/raffles');
require('./scheduler');

const app = express();
app.use(bodyParser.json());

// Use a dynamic CORS origin function. For testing, you might allow all origins:
// app.use(cors());
app.use(cors({
  origin: function (origin, callback) {
    // If no origin is provided (like in curl or postman), allow the request.
    if (!origin) return callback(null, true);
    const allowedOrigins = [
      'https://raffles.kaspercoin.net',
      // You can add other origins if needed:
      'https://kaspa-raffles-frontend-569b7d5f25f3.herokuapp.com'
    ];
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));

// Ensure preflight OPTIONS requests are handled.
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
