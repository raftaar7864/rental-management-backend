// backend/src/routes/managerTenantRoutes.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Tenant = require('../models/Tenant');
const Room = require('../models/Room');
const Building = require('../models/Building');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');

/**
 * GET /api/manager/tenants/by-buildings?buildings=id1,id2
 * Returns tenants whose room belongs to any of the provided building ids.
 * Access: manager (or admin if you choose to allow).
 */
router.get('/by-buildings', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const raw = req.query.buildings || '';
    const buildingIds = raw.split(',').map(s => s.trim()).filter(Boolean);

    if (!buildingIds.length) {
      return res.status(400).json({ message: 'building ids are required' });
    }

    // Validate ObjectId strings
    const invalid = buildingIds.find(id => !mongoose.Types.ObjectId.isValid(id));
    if (invalid) {
      return res.status(400).json({ message: `Invalid building id: ${invalid}` });
    }

    // Ensure the manager actually manages at least one of the requested buildings
    // (optional but recommended for extra safety).
    // If you want to allow managers to request other buildings, remove this block.
    const manages = await Building.find({ _id: { $in: buildingIds }, manager: req.user._id }).select('_id');
    const managedIds = (manages || []).map(b => b._id.toString());
    if (managedIds.length === 0) {
      return res.status(403).json({ message: 'Forbidden: you do not manage the requested buildings' });
    }

    // Use only buildings that the manager actually manages (defensive)
    const allowedBuildingIds = buildingIds.filter(id => managedIds.includes(id));

    // Find rooms for these buildings and collect their ids
    const rooms = await Room.find({ building: { $in: allowedBuildingIds } }).select('_id');
    const roomIds = rooms.map(r => r._id);

    if (roomIds.length === 0) {
      return res.json([]); // no rooms -> no tenants
    }

    // Find tenants assigned to those rooms
    const tenants = await Tenant.find({ room: { $in: roomIds } })
      .populate({ path: 'room', populate: { path: 'building' } });

    return res.json(tenants);
  } catch (err) {
    console.error('GET /api/manager/tenants/by-buildings error:', err);
    return res.status(500).json({ message: err.message || 'Server error' });
  }
});

// POST /api/manager/tenants
// Create tenant for a room (manager only for their rooms)
router.post('/', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const { room: roomId } = req.body;
    if (!roomId || !mongoose.Types.ObjectId.isValid(roomId)) return res.status(400).json({ message: 'room id required' });

    const room = await Room.findById(roomId).populate('building', 'manager');
    if (!room) return res.status(404).json({ message: 'Room not found' });

    if (!room.building || room.building.manager.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Forbidden: you do not manage this building' });
    }

    const tenant = await Tenant.create(req.body);

    // mark room booked
    room.tenants = room.tenants || [];
    room.tenants.push(tenant._id);
    room.isBooked = true;
    await room.save();

    const populated = await Tenant.findById(tenant._id).populate({ path: 'room', populate: { path: 'building' } });
    return res.status(201).json(populated);
  } catch (err) {
    console.error('POST /api/manager/tenants error:', err);
    return res.status(500).json({ message: 'Failed to create tenant' });
  }
});

// PUT /api/manager/tenants/:id
// Update tenant (manager must own the room/building)
router.put('/:id', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid tenant id' });

    const tenant = await Tenant.findById(id).populate({ path: 'room', populate: { path: 'building', select: 'manager' }});
    if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

    if (!tenant.room || !tenant.room.building || tenant.room.building.manager.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Forbidden: you do not manage this building' });
    }

    // If room change is allowed for managers, ensure new room belongs to same manager
    if (req.body.room && req.body.room !== tenant.room._id.toString()) {
      const newRoom = await Room.findById(req.body.room).populate('building', 'manager');
      if (!newRoom) return res.status(404).json({ message: 'New room not found' });
      if (!newRoom.building || newRoom.building.manager.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: 'Forbidden: new room is not in your building' });
      }
      // remove from old room tenants list, assign to new room, and update booking flags
      const oldRoom = await Room.findById(tenant.room._id);
      if (oldRoom) {
        oldRoom.tenants = (oldRoom.tenants || []).filter(tid => tid.toString() !== tenant._id.toString());
        await oldRoom.save();
      }
      newRoom.tenants = newRoom.tenants || [];
      newRoom.tenants.push(tenant._id);
      newRoom.isBooked = true;
      await newRoom.save();
      tenant.room = newRoom._id;
    }

    Object.assign(tenant, req.body);
    await tenant.save();

    // recompute booking state of the old room if necessary
    if (tenant.room) {
      // ensure the room's isBooked is correct
      const roomCheck = await Room.findById(tenant.room._id);
      const remaining = await Tenant.find({ room: roomCheck._id, moveOutDate: { $exists: false } });
      roomCheck.isBooked = remaining.length > 0;
      await roomCheck.save();
    }

    const populated = await Tenant.findById(tenant._id).populate({ path: 'room', populate: { path: 'building' }});
    return res.json(populated);
  } catch (err) {
    console.error('PUT /api/manager/tenants/:id error:', err);
    return res.status(500).json({ message: 'Failed to update tenant' });
  }
});


// POST /api/manager/tenants/leave/:id  (mark leave)
router.post('/leave/:id', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { leaveDate } = req.body;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid tenant id' });

    const tenant = await Tenant.findById(id).populate({ path: 'room', populate: { path: 'building', select: 'manager' }});
    if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

    if (!tenant.room || !tenant.room.building || tenant.room.building.manager.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Forbidden: you do not manage this building' });
    }

    tenant.moveOutDate = leaveDate || new Date();
    await tenant.save();

    // Update room booking status
    const room = await Room.findById(tenant.room._id);
    const remaining = await Tenant.find({ room: room._id, moveOutDate: { $exists: false } });
    room.isBooked = remaining.length > 0;
    room.tenants = (await Tenant.find({ room: room._id })).map(t => t._id);
    await room.save();

    return res.json({ message: 'Tenant marked as left' });
  } catch (err) {
    console.error('POST /api/manager/tenants/leave/:id error:', err);
    return res.status(500).json({ message: 'Failed to mark leave' });
  }
});

module.exports = router;
