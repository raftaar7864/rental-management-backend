const express = require('express');
const router = express.Router();
const roomController = require('../controllers/roomController');

router.get('/building/:buildingId', roomController.getRoomsByBuilding);
router.get('/', roomController.getAllRooms);
router.post('/', roomController.createRoom);
router.put('/:id', roomController.updateRoom);

module.exports = router;
