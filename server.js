const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const rafflesRoute = require('./routes/raffles');
require('./scheduler');

const app = express();
app.use(bodyParser.json());

// Forcefully set CORS headers for every response.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://raffles.kaspercoin.net');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  next();
});

// Additionally, handle preflight OPTIONS requests.
app.options('*', (req, res) => {
  res.sendStatus(200);
});

// (Optional) If you still wish to use the cors package for dynamic checking, you can do so before your override:
const cors = require('cors');
app.use(cors({ origin: ['https://raffles.kaspercoin.net'] }));

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
