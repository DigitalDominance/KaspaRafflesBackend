const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors'); // require cors
const rafflesRoute = require('./routes/raffles');
require('./scheduler');

const app = express();
app.use(bodyParser.json());

// Enable CORS for your specific frontend origin:
app.use(cors({
  origin: 'https://raffles.kaspercoin.net'
}));

// Optionally, handle preflight OPTIONS requests:
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
