// backend/src/routes/authRoutes.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');

// public
router.post('/login', authController.login);

// Admin-only registration & manager management
router.post('/register', requireAuth, requireRole('admin'), authController.register);

// Managers list / update / delete — admin only
router.get('/managers', requireAuth, requireRole('admin'), authController.getManagers);
router.put('/managers/:id', requireAuth, requireRole('admin'), authController.updateManager);
router.delete('/managers/:id', requireAuth, requireRole('admin'), authController.deleteManager);

module.exports = router;
