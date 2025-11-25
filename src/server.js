// backend/src/server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const morgan = require('morgan');

const app = express();

// -------------------- Middleware --------------------
const allowedOrigins = [
  'http://localhost:5173',
  'https://rentalmanagement.drbiswas.co.in',
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS blocked from origin: ${origin}`));
      }
    },
    credentials: true,
  })
);

// ⚠️ Required for Twilio incoming WhatsApp webhooks
app.use(express.urlencoded({ extended: false }));

// Parse JSON + store raw body for payment webhook
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(morgan('dev'));

// -------------------- Routes --------------------
const authRoutes = require('./routes/authRoutes');
const buildingRoutes = require('./routes/buildingRoutes');
const roomRoutes = require('./routes/roomRoutes');
const tenantRoutes = require('./routes/tenantRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const managerRoutes = require('./routes/managerRoutes');
const managerTenantRoutes = require('./routes/managerTenantRoutes');
const billRoutes = require('./routes/billRoutes');
const contactRoutes = require('./routes/contactRoutes');

// ⭐ WhatsApp Incoming Route
const whatsappIncoming = require('./routes/whatsappIncoming');

// Mount routers
app.use('/api/auth', authRoutes);
app.use('/api/buildings', buildingRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/manager', managerRoutes);
app.use('/api/manager/tenants', managerTenantRoutes);
app.use('/api/bills', billRoutes);
app.use('/api/contact', contactRoutes);

// ⭐ WhatsApp Webhook endpoint
app.use('/api/whatsapp', whatsappIncoming);

// -------------------- Payment Webhook --------------------
app.post('/api/payments/webhook', (req, res) => {
  try {
    req.rawBodyString = req.rawBody ? req.rawBody.toString() : null;

    const paymentController = require('./controllers/paymentController');
    return paymentController.webhook(req, res);
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ message: 'Webhook processing error' });
  }
});

// -------------------- Health Check --------------------
app.get('/', (req, res) => res.send('Rental Management Backend Running'));

// -------------------- Global Error Handler --------------------
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack || err);
  res.status(500).json({ message: err.message || 'Server error' });
});

// -------------------- MongoDB & Server Start --------------------
const mongoUri = process.env.MONGO_URI;
if (!mongoUri) {
  console.error('ERROR: MONGO_URI is not set.');
  process.exit(1);
}

mongoose
  .connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    console.log('MongoDB connected');

    const { scheduleMonthlyBilling } = require('./jobs/generateMonthlyBills');
    try {
      scheduleMonthlyBilling();
    } catch (err) {
      console.error('Failed to start billing scheduler:', err);
    }

    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('SIGINT received. Closing mongoose connection.');
  mongoose.connection.close(false, () => {
    console.log('MongoDB connection closed. Exiting process.');
    process.exit(0);
  });
});
