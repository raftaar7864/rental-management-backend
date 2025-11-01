// backend/src/server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const morgan = require('morgan');

const app = express();

// -------------------- Middleware --------------------
// Allow CLIENT_ORIGIN or default to vite dev server
const allowedOrigins = [
  'http://localhost:5173',
  'https://rental-management-v2.vercel.app',
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g., mobile apps, curl)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS blocked from origin: ${origin}`));
      }
    },
    credentials: true,
  })
);

// Parse JSON but ALSO capture raw body buffer for webhook verification
app.use(express.json({
  verify: (req, res, buf) => {
    // store raw body buffer for webhook handlers that need it
    req.rawBody = buf;
  }
}));

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

// Mount routers
app.use('/api/auth', authRoutes);
app.use('/api/buildings', buildingRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/manager', managerRoutes);
app.use('/api/manager/tenants', managerTenantRoutes);
app.use('/api/bills', billRoutes);

// -------------------- Payment Webhook --------------------
// Note: we capture raw body via express.json({ verify }) above as req.rawBody.
// This keeps JSON parsing for normal routes and gives raw bytes for webhooks.
app.post('/api/payments/webhook', (req, res) => {
  try {
    // Ensure raw body exists
    // If you need a string, do: req.rawBody.toString()
    req.rawBodyString = req.rawBody ? req.rawBody.toString() : null;

    const paymentController = require('./controllers/paymentController');
    return paymentController.webhook(req, res);
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ message: 'Webhook processing error' });
  }
});

// -------------------- Root Route / Health Check --------------------
app.get('/', (req, res) => res.send('Rental Management Backend Running'));
app.get('/api/rooms/test', (req, res) => res.json({ ok: true, message: '/api/rooms/test reached' }));

// -------------------- Global Error Handler --------------------
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack || err);
  res.status(500).json({ message: err.message || 'Server error' });
});

// -------------------- MongoDB & Server Start --------------------
const mongoUri = process.env.MONGO_URI;
if (!mongoUri) {
  console.error('ERROR: MONGO_URI is not set. Please update backend/.env');
  process.exit(1);
}

mongoose
  .connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    console.log('MongoDB connected');

    // Print all registered routes for debugging
    if (app._router && app._router.stack) {
      console.log('--- Express registered routes ---');
      app._router.stack.forEach((middleware) => {
        if (middleware.route) {
          console.log(middleware.route.path, Object.keys(middleware.route.methods));
        } else if (middleware.name === 'router' && middleware.handle.stack) {
          middleware.handle.stack.forEach((handler) => {
            if (handler.route) console.log(handler.route.path, Object.keys(handler.route.methods));
          });
        }
      });
    }

    // Start scheduler for monthly billing (jobs/generateMonthlyBills.js)
    try {
      const { scheduleMonthlyBilling } = require('./jobs/generateMonthlyBills');
      scheduleMonthlyBilling();
      // Optional: to run a manual generation for testing uncomment below:
      // const { runOnceForMonth } = require('./jobs/generateMonthlyBills');
      // runOnceForMonth(new Date().getFullYear(), new Date().getMonth() + 1).then(r => console.log('Manual billing run result:', r)).catch(console.error);
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

// Optional: graceful shutdown
process.on('SIGINT', () => {
  console.log('SIGINT received. Closing mongoose connection.');
  mongoose.connection.close(false, () => {
    console.log('MongoDb connection closed. Exiting process.');
    process.exit(0);
  });
});
