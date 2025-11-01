const express = require('express');
const router = express.Router();
const buildingController = require('../controllers/buildingController');

router.post('/', buildingController.createBuilding);   // Add
router.get('/', buildingController.getBuildings);      // List
router.put('/:id', buildingController.updateBuilding); // Update

module.exports = router;
