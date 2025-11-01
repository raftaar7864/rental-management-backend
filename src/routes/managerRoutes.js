// backend/src/routes/managerRoutes.js
const express = require('express');
const router = express.Router();

const { requireAuth, requireRole } = require('../middleware/authMiddleware');
const managerController = require('../controllers/managerController');

// require auth + manager role (admins may also be allowed in controllers)
// Get all rooms for the manager
router.get('/rooms', requireAuth, requireRole('manager'), managerController.getRoomsForManager);

// Get tenants for a specific room (explicit, non-ambiguous)
router.get('/rooms/:roomId/tenants', requireAuth, requireRole('manager'), managerController.getTenantsForRoom);

// Book tenant into a room
router.post('/rooms/:roomId/book', requireAuth, requireRole('manager'), managerController.bookTenantIntoRoom);

module.exports = router;
