// backend/src/routes/tenantRoutes.js
const express = require('express');
const router = express.Router();
const tenantController = require('../controllers/tenantController');

router.post('/', tenantController.createTenant);
router.get('/', tenantController.getAllTenants);
router.get('/:id', tenantController.getTenant);
router.put('/:id', tenantController.updateTenant);
router.delete('/:id', tenantController.deleteTenant);

// mark leave
router.put('/:id/mark-leave', tenantController.markLeaveTenant);

module.exports = router;
